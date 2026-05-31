// ============================================================================
// POST /api/vapi/waitlist-outcome — Sophie reports a waitlist call result.
// "yes" -> atomically claim the open slot, book via the tested book_appointment
// function, mark waitlist + queue booked, expire other queued offers, notify.
// "no"  -> mark declined, call increment_declined (FIX: v1 assigned the rpc
//          Promise directly to a column — broken; here it's a real statement).
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay } from "@/lib/vapi";
import { sendSMS, smsWaitlistBooked, smsOwnerWaitlistFilled } from "@/lib/twilio";
import type { BookResult } from "@/lib/booking-result";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "Could not process outcome.");
    toolCallId = tool.toolCallId;

    const { outcome, slotId } = tool.args as { outcome?: string; slotId?: string };
    if (!outcome || !slotId) return vapiSay(toolCallId, "Missing outcome or slot.");

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);
    if (!clinic) return vapiSay(toolCallId, "Could not resolve clinic.");

    const now = new Date().toISOString();

    // ----- YES: claim + book -----
    if (outcome === "yes") {
      // atomically claim: only succeeds if still open
      const { data: claimed } = await db()
        .from("cancelled_slots")
        .update({ status: "processing" })
        .eq("id", slotId)
        .eq("status", "open")
        .select("id, service, starts_at")
        .maybeSingle();

      if (!claimed) return vapiSay(toolCallId, "slot_taken"); // someone got it first

      // find the queued candidate we called for this slot
      const { data: queueJob } = await db()
        .from("waitlist_call_queue")
        .select("*")
        .eq("slot_id", slotId)
        .in("status", ["calling", "called"])
        .order("queue_position", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!queueJob) {
        await db().from("cancelled_slots").update({ status: "open" }).eq("id", slotId);
        return vapiSay(toolCallId, "Could not find the waitlist entry. Please call us directly.");
      }

      // book through the tested, race-safe function (same correctness as Sophie's bookings)
      const { data, error } = await db().rpc("book_appointment", {
        p_clinic: clinic.id,
        p_starts_at: claimed.starts_at,
        p_service: claimed.service ?? queueJob.service ?? "Teeth cleaning",
        p_patient_name: queueJob.patient_name,
        p_phone: queueJob.phone,
        p_source: "waitlist",
        p_is_new_patient: false,
      });
      const result = (data as unknown as BookResult) ?? { ok: false, reason: "slot_taken" };

      if (error || !result.ok) {
        await db().from("cancelled_slots").update({ status: "open" }).eq("id", slotId);
        return vapiSay(toolCallId, "slot_taken");
      }

      // mark everything booked + expire siblings
      const wlId = queueJob.waitlist_id;
      await db().from("cancelled_slots")
        .update({ status: "filled", filled_at: now, filled_by_waitlist_id: wlId ?? undefined })
        .eq("id", slotId);
      if (wlId) {
        await db().from("waitlist").update({ status: "booked" }).eq("id", wlId);
      }
      await db().from("waitlist_call_queue").update({ status: "booked", outcome: "booked" }).eq("id", queueJob.id);
      await db().from("waitlist_call_queue")
        .update({ status: "expired", outcome: "slot_filled_by_other" })
        .eq("slot_id", slotId).in("status", ["pending", "calling"]).neq("id", queueJob.id);

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
      sendSMS(queueJob.phone, smsWaitlistBooked({
        service: claimed.service ?? queueJob.service ?? "appointment",
        startsAt: claimed.starts_at, timezone: clinic.timezone, clinicName: clinic.name, clinicPhone,
      }), clinic.twilio_phone ?? undefined).catch((e) => console.error("[waitlist-outcome] SMS:", e));

      const ownerPhone = clinic.owner_phone || clinic.twilio_phone;
      if (ownerPhone) {
        sendSMS(ownerPhone, smsOwnerWaitlistFilled({
          service: claimed.service ?? queueJob.service ?? "appointment",
          startsAt: claimed.starts_at, timezone: clinic.timezone, patientName: queueJob.patient_name,
        }), clinic.twilio_phone ?? undefined).catch((e) => console.error("[waitlist-outcome] owner SMS:", e));
      }

      return vapiSay(toolCallId, "booked");
    }

    // ----- NO: decline -----
    if (outcome === "no") {
      const { data: queueJob } = await db()
        .from("waitlist_call_queue")
        .select("id, waitlist_id, patient_name")
        .eq("slot_id", slotId)
        .in("status", ["calling", "called"])
        .order("queue_position", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (queueJob) {
        await db().from("waitlist_call_queue")
          .update({ status: "declined", outcome: "patient_declined" })
          .eq("id", queueJob.id);
        // proper statement — not a Promise assigned to a column (the v1 bug)
        if (queueJob.waitlist_id) {
          await db().rpc("increment_declined", { p_waitlist_id: queueJob.waitlist_id });
        }
        // release the slot back to open for the next candidate
        await db().from("cancelled_slots").update({ status: "open" }).eq("id", slotId).eq("status", "processing");
      }
      return vapiSay(toolCallId, "declined");
    }

    return vapiSay(toolCallId, "acknowledged");
  } catch (err) {
    console.error("[waitlist-outcome] error:", err);
    return vapiSay(toolCallId, "System error.");
  }
}
