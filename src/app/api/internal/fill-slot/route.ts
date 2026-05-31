// ============================================================================
// POST /api/internal/fill-slot — internal-only. When a slot opens (e.g. a
// cancellation), build the call queue of eligible waitlist candidates for it,
// so the cascade job can work through them. Secured by x-internal-secret.
//
// Eligibility today: waiting entries for the clinic, ordered by priority then
// wait time. This is the other natural home for the future scoring engine —
// the queue it builds here is what the cascade later processes.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { CADENCE } from "@/config/app";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get("x-internal-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { slotId } = (await req.json()) as { slotId?: string };
    if (!slotId) return NextResponse.json({ error: "slotId required" }, { status: 400 });

    const { data: slot } = await db()
      .from("cancelled_slots").select("*").eq("id", slotId).eq("status", "open").maybeSingle();
    if (!slot) return NextResponse.json({ ok: true, queued: 0, reason: "slot_not_open" });

    // Rank eligible candidates with the tested scoring engine (reliability-first,
    // fit, wait time, penalties; ineligible/over-decline-cap excluded in SQL).
    const { data: scored, error: scoreErr } = await db()
      .rpc("score_waitlist_candidates", { p_slot_id: slot.id });

    let list: Array<{ waitlist_id: string; patient_name: string; phone: string; service: string | null; score: number }> = [];
    if (!scoreErr && scored) {
      list = (scored as Array<{ waitlist_id: string; patient_name: string; phone: string; service: string | null; score: number }>)
        .slice(0, CADENCE.maxCallAttempts * 3);
    } else {
      // Fallback: if scoring is unavailable, fall back to simple wait-time order
      // so a freed slot is never left unworked.
      const { data: fallback } = await db()
        .from("waitlist")
        .select("id, patient_name, phone, service")
        .eq("clinic_id", slot.clinic_id)
        .eq("status", "waiting")
        .is("deleted_at", null)
        .lt("declines", 3)
        .order("created_at", { ascending: true })
        .limit(CADENCE.maxCallAttempts * 3);
      list = (fallback ?? []).map((c) => ({
        waitlist_id: c.id, patient_name: c.patient_name, phone: c.phone, service: c.service, score: 0,
      }));
    }
    if (!list.length) return NextResponse.json({ ok: true, queued: 0 });

    // build the queue (position drives cascade order; score preserved)
    const rows = list.map((c, i) => ({
      clinic_id: slot.clinic_id,
      slot_id: slot.id,
      waitlist_id: c.waitlist_id,
      patient_name: c.patient_name,
      phone: c.phone,
      service: c.service,
      slot_starts_at: slot.starts_at,
      priority_score: Math.round(c.score),
      queue_position: i + 1,
      status: "pending" as const,
      method: "call" as const,
    }));

    const { error } = await db().from("waitlist_call_queue").insert(rows);
    if (error) {
      console.error("[fill-slot] insert error:", error.message);
      return NextResponse.json({ error: "queue insert failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, queued: rows.length });
  } catch (err) {
    console.error("[fill-slot] error:", err);
    return NextResponse.json({ error: "fill-slot failed" }, { status: 500 });
  }
}
