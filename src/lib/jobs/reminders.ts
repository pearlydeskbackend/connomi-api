// ============================================================================
// lib/jobs/reminders.ts — day-before appointment reminders.
// SMS to everyone with a confirmed booking tomorrow; PLUS a voice call for
// high-value services (crowns, implants, etc.) where a no-show costs the most.
// Idempotent via claimBookingField('reminder_sent_at'); per-clinic calling hrs.
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsReminder } from "@/lib/twilio";
import {
  isWithinCallingHours, wasContactedRecently, markContacted, claimBookingField,
} from "@/lib/cron-helpers";
import { HIGH_VALUE_SERVICES } from "@/config/app";

type ClinicJoin = { id: string; name: string; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;

export interface RemindersResult { sent: number; calls: number; skipped: number; total: number; }

export async function runReminders(opts: { force?: boolean } = {}): Promise<RemindersResult> {
  const assistantId = process.env.VAPI_REMINDER_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const { data: appts, error } = await db()
    .from("bookings")
    .select("*, clinics(id, name, owner_phone, twilio_phone, active, timezone)")
    .eq("slot_date", tomorrowStr)
    .in("status", ["scheduled", "confirmed"])
    .is("reminder_sent_at", null)
    .is("deleted_at", null);
  if (error) throw new Error(`reminders query: ${error.message}`);

  let sent = 0, calls = 0, skipped = 0;
  const list = appts ?? [];

  for (const appt of list) {
    const clinic = (appt as unknown as { clinics: ClinicJoin }).clinics;
    if (!clinic?.active) { skipped++; continue; }
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }

    // idempotency claim — prevents double-send if the job runs twice
    if (!(await claimBookingField(appt.id, "reminder_sent_at"))) { skipped++; continue; }
    if (await wasContactedRecently(clinic.id, appt.phone)) { skipped++; continue; }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    const ok = await sendSMS(appt.phone, smsReminder({
      name: appt.patient_name, service: appt.service, startsAt: appt.starts_at,
      timezone: clinic.timezone, clinicName: clinic.name, clinicPhone,
    }));
    if (ok) { sent++; await markContacted(clinic.id, appt.phone); }

    const highValue = HIGH_VALUE_SERVICES.some((s) => appt.service.toLowerCase().includes(s));
    if (highValue && assistantId && phoneNumberId) {
      const called = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: appt.phone, customerName: appt.patient_name,
        variables: {
          patientName: appt.patient_name, service: appt.service,
          callType: "reminder", clinicName: clinic.name, clinicPhone,
        },
      });
      if (called) calls++;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return { sent, calls, skipped, total: list.length };
}
