// ============================================================================
// POST /api/vapi/book — Sophie books an appointment.
// All correctness (atomic slot re-check, no double-book, patient link/create,
// hours/lead-time guards) lives in the tested book_appointment() DB function.
// This route: validate input -> call the function -> turn the typed result into
// natural speech -> fire confirmation SMS (non-blocking). No scheduling logic
// in the route; that's the whole point of v2.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic, agentNameFor } from "@/lib/clinic";
import { extractToolCall, vapiSay, checkRateLimit } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { BookingSchema } from "@/lib/validators";
import { speakableSlot } from "@/lib/speech";
import { anchorToTimezone, combineDateTime } from "@/lib/time-normalize";
import { sendSMS, smsConfirmation, smsOwnerWaitlistFilled } from "@/lib/twilio";
import type { BookResult } from "@/lib/booking-result";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I'm having trouble with our system. Please call us directly.");
    toolCallId = tool.toolCallId;

    const rl = checkRateLimit(`book:${tool.toNumber ?? toolCallId}`);
    if (!rl.allowed) return vapiSay(toolCallId, "I'm having trouble right now. Please call us directly.");

    // Resolve the clinic FIRST — we need its timezone to anchor the time.
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber, tool.assistantId);
    if (!clinic) return vapiSay(toolCallId, "I'm having trouble with our system. Please call us directly.");

    // The voice agent sends `date` (YYYY-MM-DD) + `time` ("10:00 AM") per its
    // prompt. Combine them and anchor to the clinic's timezone to get a correct
    // startsAt. Also accept a pre-formed startsAt if one is sent.
    const rawArgs = { ...(tool.args as Record<string, unknown>) };
    const datePart = typeof rawArgs.date === "string" ? rawArgs.date : null;
    const timePart = typeof rawArgs.time === "string" ? rawArgs.time : null;

    if (!rawArgs.startsAt && datePart) {
      const combined = combineDateTime(datePart, timePart, clinic.timezone);
      if (combined) rawArgs.startsAt = combined;
    } else if (typeof rawArgs.startsAt === "string") {
      const anchored = anchorToTimezone(rawArgs.startsAt, clinic.timezone);
      if (anchored) rawArgs.startsAt = anchored;
    }

    const parsed = BookingSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return vapiSay(toolCallId, "I'm missing a detail. Could you give me your name, phone number, the service, and the date and time?");
    }
    const v = parsed.data;

    const phone = normalizePhone(v.patientPhone);
    if (!phone) return vapiSay(toolCallId, "I couldn't read that phone number. Could you repeat it slowly?");

    // Single atomic, race-safe call. Returns a typed result.
    const { data, error } = await db().rpc("book_appointment", {
      p_clinic: clinic.id,
      p_starts_at: v.startsAt,
      p_service: v.service,
      p_patient_name: v.patientName,
      p_phone: phone,
      p_provider_id: v.providerId,
      p_source: "ai",
      p_is_new_patient: v.isNewPatient,
      p_notes: v.notes,
    });
    if (error) {
      console.error("[book] rpc error:", error.message);
      return vapiSay(toolCallId, "I'm having trouble completing that booking. Please call us directly.");
    }

    const result = data as unknown as BookResult;

    if (!result.ok) {
      // IDEMPOTENCY: if the slot is "taken" by THIS SAME patient, it's a
      // duplicate tool call (Vapi sometimes fires book twice) — the booking
      // already succeeded. Treat it as success rather than confusing the
      // caller with "that time was just taken."
      if (result.reason === "slot_taken") {
        const { data: existing } = await db()
          .from("bookings")
          .select("id, starts_at")
          .eq("clinic_id", clinic.id)
          .eq("phone", phone)
          .eq("starts_at", v.startsAt)
          .in("status", ["scheduled", "confirmed"])
          .maybeSingle();
        if (existing) {
          return vapiSay(
            toolCallId,
            `You're all set — your ${v.service} is booked for ${speakableSlot(existing.starts_at, clinic.timezone)}. You'll get a confirmation text shortly. Anything else?`,
          );
        }
      }
      // Map each typed failure reason to natural speech.
      switch (result.reason) {
        case "slot_taken":
        case "no_provider":
          return vapiSay(toolCallId, "That time was just taken. Let me find you the next available slot.");
        case "outside_hours":
          return vapiSay(toolCallId, "That time is outside our hours. What else works for you?");
        case "clinic_closed":
          return vapiSay(toolCallId, "We're closed that day. What other day works for you?");
        case "too_soon":
          return vapiSay(toolCallId, "That's a little too soon to book over the phone. Could we find a slightly later time?");
        default:
          return vapiSay(toolCallId, "I couldn't complete that booking. Please call us directly.");
      }
    }

    // Success — confirmation SMS, fire-and-forget so the call never waits.
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    sendSMS(
      phone,
      smsConfirmation({
        name: v.patientName, service: v.service, startsAt: result.starts_at,
        timezone: clinic.timezone, clinicName: clinic.name, clinicPhone,
        isNewPatient: v.isNewPatient,
      }),
      clinic.twilio_phone ?? undefined,
    ).catch((e) => console.error("[book] SMS error:", e));

    // If this booking filled an open cancelled slot, close the waitlist loop
    // and alert the owner (non-blocking).
    closeWaitlistLoop(result.booking_id, clinic.id, result.starts_at, v.service, v.patientName, clinic)
      .catch((e) => console.error("[book] waitlist loop:", e));

    const agent = agentNameFor(clinic);
    void agent; // available if you want Sophie to self-reference by name
    return vapiSay(
      toolCallId,
      `You're all set — your ${v.service} is booked for ${speakableSlot(result.starts_at, clinic.timezone)}. You'll get a confirmation text shortly. Anything else?`,
    );
  } catch (err) {
    console.error("[book] unhandled:", err);
    return vapiSay(toolCallId, "I'm having some trouble. Please call us directly.");
  }
}

// Close an open cancelled slot when a direct booking fills it; mark the
// waitlist entry booked and alert the owner. Best-effort, never blocks the call.
async function closeWaitlistLoop(
  bookingId: string,
  clinicId: string,
  startsAt: string,
  service: string,
  patientName: string,
  clinic: { owner_phone: string | null; twilio_phone: string | null; timezone: string },
): Promise<void> {
  const { data: slot } = await db()
    .from("cancelled_slots")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("starts_at", startsAt)
    .in("status", ["open", "processing"])
    .limit(1)
    .maybeSingle();
  if (!slot) return; // ordinary booking, not a waitlist fill

  await db()
    .from("cancelled_slots")
    .update({ status: "filled", filled_at: new Date().toISOString() })
    .eq("id", slot.id);

  const ownerPhone = clinic.owner_phone || clinic.twilio_phone;
  if (ownerPhone) {
    await sendSMS(
      ownerPhone,
      smsOwnerWaitlistFilled({ service, startsAt, timezone: clinic.timezone, patientName }),
    );
  }
  void bookingId;
}
