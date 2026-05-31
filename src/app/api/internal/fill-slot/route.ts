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

    // eligible waitlist candidates (future scoring engine refines this set)
    const { data: candidates } = await db()
      .from("waitlist")
      .select("id, patient_name, phone, service, priority, created_at")
      .eq("clinic_id", slot.clinic_id)
      .eq("status", "waiting")
      .is("deleted_at", null)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(CADENCE.maxCallAttempts * 3);

    const list = candidates ?? [];
    if (!list.length) return NextResponse.json({ ok: true, queued: 0 });

    // build the queue (position drives cascade order)
    const rows = list.map((c, i) => ({
      clinic_id: slot.clinic_id,
      slot_id: slot.id,
      waitlist_id: c.id,
      patient_name: c.patient_name,
      phone: c.phone,
      service: c.service,
      slot_starts_at: slot.starts_at,
      queue_position: i + 1,
      priority_score: c.priority,
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
