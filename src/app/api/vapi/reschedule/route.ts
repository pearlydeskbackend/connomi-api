// ============================================================================
// POST /api/vapi/reschedule — move the caller's appointment to a new time.
// DESIGN: instead of re-implementing conflict-checking (which can race), we
// reuse the tested book_appointment() for the new slot, then cancel the old
// one only if the new booking succeeds. The new slot inherits the exact same
// atomic double-book protection we proved for booking. If the new time is
// unavailable, the old appointment is left untouched.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay, checkRateLimit } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { RescheduleSchema } from "@/lib/validators";
import { findNextBooking } from "@/lib/lookup";
import { sendSMS, smsReschedule } from "@/lib/twilio";
import { speakableSlot } from "@/lib/speech";
import type { BookResult } from "@/lib/booking-result";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I'm having trouble with our system. Please call us directly.");
    toolCallId = tool.toolCallId;

    const rl = checkRateLimit(`resched:${tool.toNumber ?? toolCallId}`);
    if (!rl.allowed) return vapiSay(toolCallId, "I'm having trouble right now. Please call us directly.");

    const parsed = RescheduleSchema.safeParse(tool.args);
    if (!parsed.success) return vapiSay(toolCallId, "I need your phone number and the new date and time you'd like.");

    const phone = normalizePhone(parsed.data.patientPhone);
    if (!phone) return vapiSay(toolCallId, "I couldn't read that phone number. Could you repeat it?");

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);
    if (!clinic) return vapiSay(toolCallId, "I'm having trouble with our system. Please call us directly.");

    const existing = await findNextBooking(clinic.id, phone);
    if (!existing) {
      return vapiSay(toolCallId, "I couldn't find an upcoming booking under that number. Could you double-check, or call us directly?");
    }

    // Try to claim the new slot via the atomic booking function (same service,
    // same patient). This is race-safe and won't double-book.
    const { data, error } = await db().rpc("book_appointment", {
      p_clinic: clinic.id,
      p_starts_at: parsed.data.newStartsAt,
      p_service: existing.service,
      p_patient_name: existing.patient_name,
      p_phone: phone,
      p_provider_id: existing.provider_id ?? undefined,
      p_source: "ai",
      p_is_new_patient: false,
      p_notes: `Rescheduled from ${existing.starts_at}`,
    });
    if (error) {
      console.error("[reschedule] rpc error:", error.message);
      return vapiSay(toolCallId, "I'm having trouble moving that. Please call us directly.");
    }

    const result = data as unknown as BookResult;
    if (!result.ok) {
      switch (result.reason) {
        case "slot_taken":
        case "no_provider":
          return vapiSay(toolCallId, "That new time is already taken. Could you pick another?");
        case "outside_hours":
          return vapiSay(toolCallId, "That time is outside our hours. What else works?");
        case "clinic_closed":
          return vapiSay(toolCallId, "We're closed that day. What other day works?");
        case "too_soon":
          return vapiSay(toolCallId, "That's a bit too soon to move it to over the phone. A slightly later time?");
        default:
          return vapiSay(toolCallId, "I couldn't move that appointment. Please call us directly.");
      }
    }

    // New slot secured — now release the old one.
    await db()
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), notes: "Rescheduled" })
      .eq("id", existing.id);

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    sendSMS(
      phone,
      smsReschedule({
        name: existing.patient_name, service: existing.service,
        startsAt: result.starts_at, timezone: clinic.timezone,
        clinicName: clinic.name, clinicPhone,
      }),
    ).catch((e) => console.error("[reschedule] SMS error:", e));

    return vapiSay(
      toolCallId,
      `Done — your ${existing.service} is moved to ${speakableSlot(result.starts_at, clinic.timezone)}. You'll get a confirmation text. See you then!`,
    );
  } catch (err) {
    console.error("[reschedule] unhandled:", err);
    return vapiSay(toolCallId, "I'm having some trouble. Please call us directly.");
  }
}
