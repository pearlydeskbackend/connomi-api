// ============================================================================
// POST /api/web/book — PUBLIC. Books an appointment from the website form.
// Body: { embedKey, patientName, patientPhone, service, date, time | startsAt,
//         isNewPatient? }. Uses the SAME tested book_appointment engine, the
// same timezone anchoring, the same idempotency, and sends the same
// confirmation SMS as the phone flow. Clinic resolved from the embed key.
// ============================================================================
import { NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { resolveWebContext, jsonCors, preflight } from "@/lib/web";
import { normalizePhone } from "@/lib/phone";
import { anchorToTimezone, combineDateTime } from "@/lib/time-normalize";
import { speakableSlot } from "@/lib/speech";
import { sendSMS, smsConfirmation } from "@/lib/twilio";
import type { BookResult } from "@/lib/booking-result";

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ ok: false, error: "invalid_json" }, 400);
  }

  const resolved = await resolveWebContext(req, body);
  if ("error" in resolved) return resolved.error;
  const { clinic } = resolved.ctx;

  const patientName = typeof body.patientName === "string" ? body.patientName.trim() : "";
  const rawPhone = typeof body.patientPhone === "string" ? body.patientPhone : "";
  const service = typeof body.service === "string" ? body.service : "Teeth cleaning";
  const isNewPatient = body.isNewPatient === true;

  if (!patientName) return jsonCors({ ok: false, error: "missing_name" }, 400);
  const phone = normalizePhone(rawPhone);
  if (!phone) return jsonCors({ ok: false, error: "invalid_phone" }, 400);

  // Accept either a pre-formed startsAt, or date + time — anchored to clinic tz.
  let startsAt: string | null = null;
  if (typeof body.startsAt === "string") {
    startsAt = anchorToTimezone(body.startsAt, clinic.timezone);
  } else if (typeof body.date === "string") {
    const time = typeof body.time === "string" ? body.time : null;
    startsAt = combineDateTime(body.date, time, clinic.timezone);
  }
  if (!startsAt) return jsonCors({ ok: false, error: "invalid_datetime" }, 400);

  const { data, error } = await db().rpc("book_appointment", {
    p_clinic: clinic.id,
    p_starts_at: startsAt,
    p_service: service,
    p_patient_name: patientName,
    p_phone: phone,
    p_source: "online",
    p_is_new_patient: isNewPatient,
  });
  if (error) {
    return jsonCors({ ok: false, error: "booking_failed" }, 500);
  }
  const result = data as unknown as BookResult;

  if (!result.ok) {
    // Idempotency: same patient already holds this slot -> treat as success.
    if (result.reason === "slot_taken") {
      const { data: existing } = await db()
        .from("bookings")
        .select("id, starts_at")
        .eq("clinic_id", clinic.id)
        .eq("phone", phone)
        .eq("starts_at", startsAt)
        .in("status", ["scheduled", "confirmed"])
        .maybeSingle();
      if (existing) {
        return jsonCors({
          ok: true,
          alreadyBooked: true,
          bookingId: existing.id,
          startsAt: existing.starts_at,
          label: speakableSlot(existing.starts_at, clinic.timezone),
        });
      }
    }
    const messages: Record<string, string> = {
      slot_taken: "That time was just taken. Please pick another slot.",
      no_provider: "That time was just taken. Please pick another slot.",
      outside_hours: "That time is outside the clinic's hours.",
      clinic_closed: "The clinic is closed that day.",
      too_soon: "That time is too soon to book online. Please pick a later slot.",
    };
    return jsonCors({
      ok: false,
      error: result.reason ?? "booking_failed",
      message: messages[result.reason ?? ""] ?? "Could not complete the booking.",
    }, 409);
  }

  // Confirmation SMS — from the clinic's own number (falls back to platform).
  sendSMS(
    phone,
    smsConfirmation({
      name: patientName,
      service,
      startsAt: result.starts_at!,
      timezone: clinic.timezone,
      clinicName: clinic.name,
      clinicPhone: clinic.twilio_phone || clinic.owner_phone || "",
      isNewPatient,
    }),
    clinic.twilio_phone ?? undefined,
  ).catch((e) => console.error("[web/book] SMS error:", e));

  return jsonCors({
    ok: true,
    bookingId: result.booking_id,
    startsAt: result.starts_at,
    label: speakableSlot(result.starts_at!, clinic.timezone),
    clinic: { name: clinic.name },
  });
}
