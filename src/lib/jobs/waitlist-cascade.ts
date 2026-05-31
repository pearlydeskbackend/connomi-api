// ============================================================================
// lib/jobs/waitlist-cascade.ts — works the waitlist call queue.
// For each due job: validate the slot is still open + not passed + patient
// still waiting, atomically claim it (pending -> calling), then reach out via
// the chosen channel. Scoring + channel come from waitlist-strategy.ts (the
// seams the future intelligent engine replaces).
// ============================================================================
import { db } from "@/lib/supabase";
import { triggerVapiCall } from "@/lib/vapi";
import { sendSMS, smsWaitlistOffer } from "@/lib/twilio";
import { speakableSlot } from "@/lib/speech";
import { scoreCandidates, selectChannel, type QueueCandidate } from "@/lib/jobs/waitlist-strategy";

type ClinicJoin = { name: string; owner_phone: string | null; twilio_phone: string | null; timezone: string } | null;
type SlotJoin = { status: string; starts_at: string; service: string | null } | null;

export interface CascadeResult { processed: number; called: number; sms: number; skipped: number; }

export async function runWaitlistCascade(): Promise<CascadeResult> {
  const assistantId = process.env.VAPI_WAITLIST_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const now = new Date().toISOString();

  const { data: jobs, error } = await db()
    .from("waitlist_call_queue")
    .select(`*, cancelled_slots!slot_id(status, starts_at, service), clinics!clinic_id(name, owner_phone, twilio_phone, timezone)`)
    .eq("status", "pending")
    .lte("scheduled_at", now)
    .order("queue_position", { ascending: true })
    .limit(20);
  if (error) throw new Error(`cascade query: ${error.message}`);

  let called = 0, sms = 0, skipped = 0;
  const list = jobs ?? [];

  // strategy seam: rank the due jobs (today: by queue_position)
  const ranked = scoreCandidates(
    list.map((j) => ({
      id: j.id, waitlist_id: j.waitlist_id, patient_name: j.patient_name,
      phone: j.phone, service: j.service, slot_starts_at: j.slot_starts_at,
      queue_position: j.queue_position, priority_score: j.priority_score, method: j.method,
    })) as QueueCandidate[],
  );

  for (const cand of ranked) {
    const job = list.find((j) => j.id === cand.id)!;
    const slot = (job as unknown as { cancelled_slots: SlotJoin }).cancelled_slots;
    const clinic = (job as unknown as { clinics: ClinicJoin }).clinics;

    // slot no longer open -> expire this job
    if (!slot || slot.status !== "open") {
      await db().from("waitlist_call_queue").update({ status: "expired", outcome: "slot_not_open" }).eq("id", job.id);
      skipped++; continue;
    }
    // slot already passed -> expire job + slot
    if (new Date(slot.starts_at).getTime() < Date.now()) {
      await db().from("waitlist_call_queue").update({ status: "expired", outcome: "slot_passed" }).eq("id", job.id);
      await db().from("cancelled_slots").update({ status: "expired" }).eq("id", job.slot_id ?? "");
      skipped++; continue;
    }
    // patient no longer waiting -> skip
    if (job.waitlist_id) {
      const { data: wl } = await db().from("waitlist").select("status").eq("id", job.waitlist_id).maybeSingle();
      if (!wl || wl.status !== "waiting") {
        await db().from("waitlist_call_queue").update({ status: "skipped", outcome: "patient_unavailable" }).eq("id", job.id);
        skipped++; continue;
      }
    }

    // atomically claim: pending -> calling (prevents double-contact)
    const { data: claimed } = await db()
      .from("waitlist_call_queue")
      .update({ status: "calling", attempted_at: now })
      .eq("id", job.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (!claimed) { skipped++; continue; }

    if (job.waitlist_id) {
      await db().from("waitlist").update({ status: "offered", last_attempt_at: now })
        .eq("id", job.waitlist_id).eq("status", "waiting");
    }

    const clinicPhone = clinic?.twilio_phone || clinic?.owner_phone || "";
    const clinicName = clinic?.name || "the clinic";
    const tz = clinic?.timezone || "America/Vancouver";
    const channel = selectChannel(cand); // strategy seam
    let ok = false;

    if (channel === "sms") {
      ok = await sendSMS(job.phone, smsWaitlistOffer({
        name: job.patient_name, service: job.service ?? "appointment",
        startsAt: slot.starts_at, timezone: tz, clinicName, clinicPhone,
      }), clinic?.twilio_phone ?? undefined);
      if (ok) {
        sms++;
        await db().from("waitlist_call_queue").update({ status: "called", outcome: "sms_sent" }).eq("id", job.id);
        if (job.waitlist_id) await db().from("waitlist").update({ status: "waiting" }).eq("id", job.waitlist_id);
      }
    } else if (assistantId && phoneNumberId) {
      ok = await triggerVapiCall({
        assistantId, phoneNumberId,
        customerPhone: job.phone, customerName: job.patient_name,
        variables: {
          patientName: job.patient_name,
          availableDateSpoken: speakableSlot(slot.starts_at, tz),
          service: job.service ?? "appointment",
          slotId: job.slot_id ?? "",
          clinicName, clinicPhone,
        },
      });
      if (ok) {
        called++;
        await db().from("waitlist_call_queue").update({ status: "called", outcome: "call_initiated" }).eq("id", job.id);
      }
    }

    if (!ok) {
      await db().from("waitlist_call_queue").update({ status: "skipped", outcome: "contact_failed" }).eq("id", job.id);
      if (job.waitlist_id) await db().from("waitlist").update({ status: "waiting" }).eq("id", job.waitlist_id);
      skipped++;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return { processed: list.length, called, sms, skipped };
}
