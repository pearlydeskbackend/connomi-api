// ============================================================================
// lib/jobs/recall.ts — RECALL job logic (decoupled from any scheduler).
// Plain async function: find overdue patients, run the multi-step sequence
// (call → call → SMS-only), respect per-clinic calling hours + 24h dedup,
// advance each patient's sequence state. Callable from Inngest OR a plain
// endpoint OR a test — it knows nothing about how it's triggered.
//
// Sequence (per-clinic-tunable later): step0 call (+SMS) → +3d, step1 call
// (+SMS) → +5d, step2 final SMS → exhausted.
// ============================================================================
import { db } from "@/lib/supabase";
import { env } from "@/config/env";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from "@/lib/twilio";
import {
  isWithinCallingHours, wasContactedRecently, markContacted, daysFromNowIso,
} from "@/lib/cron-helpers";
import { CADENCE } from "@/config/app";

interface SequenceStep { action: "call" | "sms"; daysUntilNext: number | null; }
const SEQUENCE: SequenceStep[] = [
  { action: "call", daysUntilNext: 3 },
  { action: "call", daysUntilNext: 5 },
  { action: "sms", daysUntilNext: null },
];

export interface RecallResult {
  called: number; smsOnly: number; skipped: number; total: number;
}

export async function runRecall(opts: { force?: boolean; batchSize?: number } = {}): Promise<RecallResult> {
  const e = env();
  const assistantId = process.env.VAPI_RECALL_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!assistantId || !phoneNumberId) {
    throw new Error("VAPI_RECALL_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID not set");
  }

  const now = new Date().toISOString();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CADENCE.recallMonths);
  const cutoffDate = cutoff.toISOString().split("T")[0];

  // overdue, due-for-next-attempt patients with their clinic
  const { data: patients, error } = await db()
    .from("patients")
    .select("*, clinics(id, name, owner_phone, twilio_phone, active, timezone)")
    .lt("last_cleaning_date", cutoffDate)
    .in("recall_status", ["pending", "in_progress"])
    .is("deleted_at", null)
    .or(`recall_next_attempt_at.is.null,recall_next_attempt_at.lte.${now}`)
    .order("recall_next_attempt_at", { ascending: true, nullsFirst: true })
    .limit(opts.batchSize ?? 15);
  if (error) throw new Error(`recall query: ${error.message}`);

  let called = 0, smsOnly = 0, skipped = 0;
  const list = patients ?? [];

  for (const patient of list) {
    const clinic = (patient as unknown as {
      clinics: { id: string; name: string; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;
    }).clinics;
    if (!clinic?.active) { skipped++; continue; }

    // respect this clinic's calling hours (not a global tz)
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }

    if (await wasContactedRecently(clinic.id, patient.phone)) { skipped++; continue; }

    const step = patient.recall_sequence_step ?? 0;
    const seq = SEQUENCE[step];
    if (!seq) {
      await db().from("patients").update({ recall_status: "exhausted" }).eq("id", patient.id);
      skipped++; continue;
    }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
    let ok = false;

    if (seq.action === "call") {
      ok = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: patient.phone, customerName: patient.name,
        variables: {
          patientName: patient.name,
          lastCleaningDate: patient.last_cleaning_date || "a while ago",
          lastService: patient.recall_last_service || "cleaning",
          attemptNumber: String(step + 1),
          clinicName: clinic.name, clinicPhone,
        },
      });
      if (ok) {
        called++;
        await sendSMS(
          patient.phone,
          step >= 1
            ? smsRecallFinal({ name: patient.name, clinicName: clinic.name, clinicPhone })
            : smsRecallFollowUp({ name: patient.name, clinicName: clinic.name, clinicPhone, step: step + 1 }),
          clinic.twilio_phone ?? undefined,
        );
        await markContacted(clinic.id, patient.phone);
      }
    } else {
      ok = await sendSMS(patient.phone, smsRecallFinal({ name: patient.name, clinicName: clinic.name, clinicPhone }), clinic.twilio_phone ?? undefined);
      if (ok) { smsOnly++; await markContacted(clinic.id, patient.phone); }
    }

    if (ok) {
      const nextStep = step + 1;
      const exhausted = !SEQUENCE[nextStep];
      await db().from("patients").update({
        recall_status: exhausted ? "exhausted" : "in_progress",
        recall_sequence_step: nextStep,
        recall_attempts: (patient.recall_attempts ?? 0) + 1,
        recall_next_attempt_at: exhausted ? null : daysFromNowIso(seq.daysUntilNext!),
        last_contacted_at: now,
      }).eq("id", patient.id);
    }

    await new Promise((r) => setTimeout(r, 2000)); // gentle pacing between patients
  }

  void e;
  return { called, smsOnly, skipped, total: list.length };
}
