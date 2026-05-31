// ============================================================================
// POST /api/vapi/cancel — Sophie cancels the caller's upcoming appointment.
// Finds the next booking by phone, marks it cancelled, fires the cancellation
// SMS, and — if the slot is far enough out — opens a cancelled_slots record so
// the waitlist-fill engine can backfill it. The "far enough out" threshold is
// the clinic's configurable lead time, not a hardcoded 2 hours.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay, checkRateLimit } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { CancelSchema } from "@/lib/validators";
import { findNextBooking } from "@/lib/lookup";
import { sendSMS, smsCancellation } from "@/lib/twilio";
import { speakableSlot } from "@/lib/speech";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I'm having trouble with our system. Please call us directly.");
    toolCallId = tool.toolCallId;

    const rl = checkRateLimit(`cancel:${tool.toNumber ?? toolCallId}`);
    if (!rl.allowed) return vapiSay(toolCallId, "I'm having trouble right now. Please call us directly.");

    const parsed = CancelSchema.safeParse(tool.args);
    if (!parsed.success) return vapiSay(toolCallId, "Could I get your name and phone number to find your booking?");

    const phone = normalizePhone(parsed.data.patientPhone);
    if (!phone) return vapiSay(toolCallId, "I couldn't read that phone number. Could you repeat it?");

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber, tool.assistantId);
    if (!clinic) return vapiSay(toolCallId, "I'm having trouble with our system. Please call us directly.");

    const booking = await findNextBooking(clinic.id, phone);
    if (!booking) {
      return vapiSay(toolCallId, "I couldn't find an upcoming booking under that number. Could you double-check, or call us directly?");
    }

    const now = new Date().toISOString();
    await db()
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: now })
      .eq("id", booking.id);

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    sendSMS(
      phone,
      smsCancellation({
        name: booking.patient_name, service: booking.service,
        startsAt: booking.starts_at, timezone: clinic.timezone,
        clinicName: clinic.name, clinicPhone,
      }),
      clinic.twilio_phone ?? undefined,
    ).catch((e) => console.error("[cancel] SMS error:", e));

    // Open the slot for waitlist fill only if it's beyond the clinic's lead time.
    const leadMs = (clinic.min_lead_time_minutes || 0) * 60_000;
    const farEnough = new Date(booking.starts_at).getTime() - Date.now() > Math.max(leadMs, 2 * 60 * 60_000);
    if (farEnough) {
      const { data: slot } = await db()
        .from("cancelled_slots")
        .insert({
          clinic_id: clinic.id,
          booking_id: booking.id,
          service: booking.service,
          starts_at: booking.starts_at,
          status: "open",
        })
        .select("id")
        .maybeSingle();
      if (slot) {
        // trigger the internal fill engine (non-blocking)
        triggerFill(slot.id).catch((e) => console.error("[cancel] fill trigger:", e));
      }
    }

    return vapiSay(
      toolCallId,
      `Done — your ${booking.service} on ${speakableSlot(booking.starts_at, clinic.timezone)} is cancelled. You'll get a text confirming it. Would you like to rebook, or join our waitlist for an earlier opening?`,
    );
  } catch (err) {
    console.error("[cancel] unhandled:", err);
    return vapiSay(toolCallId, "I'm having some trouble. Please call us directly.");
  }
}

// fire the internal fill-slot worker; uses the platform dashboard origin
async function triggerFill(slotId: string): Promise<void> {
  const { env } = await import("@/config/env");
  const base = env().DASHBOARD_URL;
  await fetch(`${base.replace(/\/$/, "")}/api/internal/fill-slot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": process.env.CRON_SECRET ?? "",
    },
    body: JSON.stringify({ slotId }),
  });
}
