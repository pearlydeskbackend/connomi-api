// ============================================================================
// lib/jobs/followup.ts — post-visit care follow-up 48-60h after a COMPLETED
// visit. High-value procedures get a Sophie call; routine visits get a warm
// SMS. Skips consults, no-shows, cancellations. Records followup_type.
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsFollowupLight } from "@/lib/twilio";
import {
  isWithinCallingHours, wasContactedRecently, markContacted, claimBookingField,
} from "@/lib/cron-helpers";
import { HIGH_VALUE_SERVICES } from "@/config/app";

type ClinicJoin = { id: string; name: string; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;

export interface FollowupResult { calls: number; sms: number; skipped: number; total: number; }

function followupType(service: string): "call" | "sms" {
  return HIGH_VALUE_SERVICES.some((s) => service.toLowerCase().includes(s)) ? "call" : "sms";
}

export async function runFollowup(opts: { force?: boolean } = {}): Promise<FollowupResult> {
  const assistantId = process.env.VAPI_REMINDER_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const now = new Date().toISOString();

  const start = new Date(Date.now() - 60 * 3_600_000).toISOString().split("T")[0];
  const end = new Date(Date.now() - 48 * 3_600_000).toISOString().split("T")[0];

  const { data: appts, error } = await db()
    .from("bookings")
    .select("*, clinics(id, name, owner_phone, twilio_phone, active, timezone)")
    .eq("status", "completed")
    .gte("slot_date", start).lte("slot_date", end)
    .is("followup_sent_at", null)
    .is("deleted_at", null)
    .not("service", "ilike", "%consult%")
    .order("slot_date", { ascending: true })
    .limit(20);
  if (error) throw new Error(`followup query: ${error.message}`);

  let calls = 0, sms = 0, skipped = 0;
  const list = appts ?? [];

  for (const appt of list) {
    const clinic = (appt as unknown as { clinics: ClinicJoin }).clinics;
    if (!clinic?.active) { skipped++; continue; }
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }
    if (!(await claimBookingField(appt.id, "followup_sent_at"))) { skipped++; continue; }
    if (await wasContactedRecently(clinic.id, appt.phone)) { skipped++; continue; }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    const type = followupType(appt.service);
    let sent = false;

    if (type === "call" && assistantId && phoneNumberId) {
      sent = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: appt.phone, customerName: appt.patient_name,
        variables: {
          patientName: appt.patient_name, service: appt.service,
          callType: "followup", clinicName: clinic.name, clinicPhone,
        },
      });
      if (sent) calls++;
    } else {
      sent = await sendSMS(appt.phone, smsFollowupLight({
        name: appt.patient_name, service: appt.service, clinicName: clinic.name, clinicPhone,
      }));
      if (sent) sms++;
    }

    if (sent) {
      await db().from("bookings").update({ followup_type: type }).eq("id", appt.id);
      await markContacted(clinic.id, appt.phone);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  void now;
  return { calls, sms, skipped, total: list.length };
}
