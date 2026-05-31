// ============================================================================
// lib/jobs/noshow.ts — detect yesterday's no-shows and try to recover them.
// Only flags 'confirmed' bookings (not ones the patient actively confirmed by
// reply, which likely attended). Marks no_show_at FIRST (prevents double
// processing + overlaps with the reappointment job), then calls + texts.
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsNoShow } from "@/lib/twilio";
import { isWithinCallingHours, wasContactedRecently, markContacted } from "@/lib/cron-helpers";

type ClinicJoin = { id: string; name: string; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;

export interface NoShowResult { processed: number; skipped: number; total: number; }

export async function runNoShow(opts: { force?: boolean } = {}): Promise<NoShowResult> {
  const assistantId = process.env.VAPI_RECALL_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  const now = new Date().toISOString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const { data: appts, error } = await db()
    .from("bookings")
    .select("*, clinics(id, name, owner_phone, twilio_phone, active, timezone)")
    .eq("slot_date", yesterdayStr)
    .eq("status", "confirmed")          // not patient-confirmed; those likely attended
    .is("no_show_at", null)
    .is("cancelled_at", null)
    .is("reappointment_sent_at", null)
    .is("deleted_at", null);
  if (error) throw new Error(`noshow query: ${error.message}`);

  let processed = 0, skipped = 0;
  const list = appts ?? [];

  for (const appt of list) {
    const clinic = (appt as unknown as { clinics: ClinicJoin }).clinics;
    if (!clinic?.active) { skipped++; continue; }
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }
    if (await wasContactedRecently(clinic.id, appt.phone)) { skipped++; continue; }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";

    // mark no-show FIRST to prevent double processing
    await db().from("bookings").update({ status: "no_show", no_show_at: now }).eq("id", appt.id);

    if (assistantId && phoneNumberId) {
      const ok = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: appt.phone, customerName: appt.patient_name,
        variables: {
          patientName: appt.patient_name, service: appt.service,
          callType: "noshow", clinicName: clinic.name, clinicPhone,
        },
      });
      if (ok) await markContacted(clinic.id, appt.phone);
    }

    sendSMS(appt.phone, smsNoShow({
      name: appt.patient_name, service: appt.service, clinicName: clinic.name, clinicPhone,
    }), clinic.twilio_phone ?? undefined).catch((e) => console.error("[noshow] SMS:", e));

    processed++;
    await new Promise((r) => setTimeout(r, 2000));
  }

  return { processed, skipped, total: list.length };
}
