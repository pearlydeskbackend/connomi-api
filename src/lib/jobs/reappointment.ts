// ============================================================================
// lib/jobs/reappointment.ts — day after a completed visit, if the patient has
// NO future booking, call + text to rebook. Marks reappointment_sent_at to
// avoid overlap with the no-show job. Skips anyone with a future appointment.
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsReappointment } from "@/lib/twilio";
import { isWithinCallingHours, wasContactedRecently, markContacted } from "@/lib/cron-helpers";

type ClinicJoin = { id: string; name: string; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;

export interface ReappointmentResult { called: number; skipped: number; total: number; }

export async function runReappointment(opts: { force?: boolean } = {}): Promise<ReappointmentResult> {
  const assistantId = process.env.VAPI_RECALL_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const now = new Date().toISOString();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const { data: appts, error } = await db()
    .from("bookings")
    .select("*, clinics(id, name, owner_phone, twilio_phone, active, timezone)")
    .eq("slot_date", yesterdayStr)
    .eq("status", "completed")
    .is("reappointment_sent_at", null)
    .is("deleted_at", null);
  if (error) throw new Error(`reappointment query: ${error.message}`);

  let called = 0, skipped = 0;
  const list = appts ?? [];

  for (const appt of list) {
    const clinic = (appt as unknown as { clinics: ClinicJoin }).clinics;
    if (!clinic?.active) { skipped++; continue; }
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }

    const markHandled = () =>
      db().from("bookings").update({ reappointment_sent_at: now }).eq("id", appt.id);

    if (await wasContactedRecently(clinic.id, appt.phone)) { skipped++; await markHandled(); continue; }

    // already has a future booking? nothing to do.
    const { data: future } = await db()
      .from("bookings").select("id")
      .eq("clinic_id", clinic.id).eq("phone", appt.phone)
      .in("status", ["scheduled", "confirmed"])
      .gt("slot_date", yesterdayStr).limit(1).maybeSingle();
    if (future) { skipped++; await markHandled(); continue; }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    if (assistantId && phoneNumberId) {
      const ok = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: appt.phone, customerName: appt.patient_name,
        variables: {
          patientName: appt.patient_name, service: appt.service,
          callType: "reappointment", clinicName: clinic.name, clinicPhone,
        },
      });
      if (ok) {
        called++;
        await markContacted(clinic.id, appt.phone);
        sendSMS(appt.phone, smsReappointment({ name: appt.patient_name, clinicName: clinic.name, clinicPhone }), clinic.twilio_phone ?? undefined)
          .catch((e) => console.error("[reappointment] SMS:", e));
        await markHandled();
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { called, skipped, total: list.length };
}
