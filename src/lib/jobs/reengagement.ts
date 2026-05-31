// ============================================================================
// lib/jobs/reengagement.ts — win back 12-month-dormant patients (one call,
// never re-engaged before, not opted out). Personalized with last-visit
// context. Per-clinic loop + calling hours + 24h dedup.
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { isWithinCallingHours, wasContactedRecently, markContacted } from "@/lib/cron-helpers";
import { CADENCE } from "@/config/app";

export interface ReengagementResult { called: number; skipped: number; }

export async function runReengagement(opts: { force?: boolean; perClinic?: number } = {}): Promise<ReengagementResult> {
  const assistantId = process.env.VAPI_REENGAGEMENT_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!assistantId || !phoneNumberId) throw new Error("VAPI_REENGAGEMENT_ASSISTANT_ID not set");

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CADENCE.reengagementMonths);

  const { data: clinics } = await db()
    .from("clinics").select("id, name, owner_phone, twilio_phone, timezone").eq("active", true);

  let called = 0, skipped = 0;
  for (const clinic of clinics ?? []) {
    if (!isWithinCallingHours(clinic.timezone, opts.force)) continue;

    const { data: patients } = await db()
      .from("patients")
      .select("id, name, phone, recall_attempts, recall_last_service, last_cleaning_date")
      .eq("clinic_id", clinic.id)
      .lt("updated_at", cutoff.toISOString())
      .lt("recall_attempts", 1)
      .neq("recall_status", "opted_out")
      .is("deleted_at", null)
      .limit(opts.perClinic ?? 5);

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    for (const patient of patients ?? []) {
      if (await wasContactedRecently(clinic.id, patient.phone)) { skipped++; continue; }

      const { data: last } = await db()
        .from("bookings").select("starts_at, service")
        .eq("clinic_id", clinic.id).eq("phone", patient.phone)
        .eq("status", "completed").order("starts_at", { ascending: false })
        .limit(1).maybeSingle();

      const lastVisitDate = last?.starts_at?.split("T")[0] || patient.last_cleaning_date || "a while ago";
      const lastService = last?.service || patient.recall_last_service || "your last visit";
      const monthsAway = last?.starts_at
        ? Math.round((Date.now() - new Date(last.starts_at).getTime()) / (30 * 86_400_000))
        : CADENCE.reengagementMonths;

      const ok = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: patient.phone, customerName: patient.name,
        variables: {
          patientName: patient.name, lastVisitDate, lastService,
          monthsAway: String(monthsAway), callType: "reengagement",
          clinicName: clinic.name, clinicPhone,
        },
      });
      if (ok) {
        await db().from("patients").update({
          recall_attempts: (patient.recall_attempts ?? 0) + 1,
          last_contacted_at: new Date().toISOString(),
        }).eq("id", patient.id);
        await markContacted(clinic.id, patient.phone);
        called++;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { called, skipped };
}
