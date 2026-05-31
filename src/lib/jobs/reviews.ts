// ============================================================================
// lib/jobs/reviews.ts — post-visit Google review requests.
// N days after a COMPLETED visit, text the review link — but suppress anyone
// who had an urgent/emergency message or an unresolved call around their visit
// (don't solicit a review from an unhappy patient). Idempotent via
// claimBookingField('review_sent_at').
// ============================================================================
import { db } from "@/lib/supabase";
import { sendSMS, smsReview } from "@/lib/twilio";
import {
  isWithinCallingHours, wasContactedRecently, markContacted, claimBookingField,
} from "@/lib/cron-helpers";
import { REVIEWS } from "@/config/app";

type ClinicJoin = { id: string; name: string; google_review_link: string | null; owner_phone: string | null; twilio_phone: string | null; active: boolean; timezone: string } | null;

export interface ReviewsResult { sent: number; failed: number; skipped: number; total: number; date: string; }

async function hadComplaint(clinicId: string, phone: string, visitISO: string): Promise<boolean> {
  const before = new Date(visitISO); before.setDate(before.getDate() - REVIEWS.complaintWindowDays);
  const after = new Date(visitISO); after.setDate(after.getDate() + REVIEWS.complaintWindowDays);

  const { data: msgs } = await db()
    .from("messages").select("id")
    .eq("clinic_id", clinicId).eq("phone", phone)
    .in("urgency", ["urgent", "emergency"])
    .gte("created_at", before.toISOString()).lte("created_at", after.toISOString())
    .limit(1);
  if (msgs?.length) return true;

  const { data: calls } = await db()
    .from("call_logs").select("id")
    .eq("clinic_id", clinicId).eq("outcome", "unresolved")
    .gte("created_at", before.toISOString()).lte("created_at", after.toISOString())
    .limit(1);
  return !!calls?.length;
}

export async function runReviews(opts: { force?: boolean } = {}): Promise<ReviewsResult> {
  const target = new Date();
  target.setDate(target.getDate() - REVIEWS.daysAfterVisit);
  const targetDate = target.toISOString().split("T")[0];

  const { data: appts, error } = await db()
    .from("bookings")
    .select("*, clinics(id, name, google_review_link, owner_phone, twilio_phone, active, timezone)")
    .eq("slot_date", targetDate)
    .eq("status", "completed")
    .is("review_sent_at", null)
    .is("deleted_at", null)
    .not("phone", "is", null);
  if (error) throw new Error(`reviews query: ${error.message}`);

  let sent = 0, failed = 0, skipped = 0;
  const list = appts ?? [];

  for (const appt of list) {
    const clinic = (appt as unknown as { clinics: ClinicJoin }).clinics;
    if (!clinic?.active) { skipped++; continue; }
    if (!isWithinCallingHours(clinic.timezone, opts.force)) { skipped++; continue; }
    if (!clinic.google_review_link) { skipped++; continue; }

    if (!(await claimBookingField(appt.id, "review_sent_at"))) { skipped++; continue; }
    if (await wasContactedRecently(clinic.id, appt.phone)) { skipped++; continue; }
    if (await hadComplaint(clinic.id, appt.phone, appt.starts_at)) { skipped++; continue; }

    const ok = await sendSMS(appt.phone, smsReview({
      name: appt.patient_name, clinicName: clinic.name, reviewLink: clinic.google_review_link,
    }), clinic.twilio_phone ?? undefined);
    if (ok) { sent++; await markContacted(clinic.id, appt.phone); }
    else failed++;

    await new Promise((r) => setTimeout(r, 300));
  }

  return { sent, failed, skipped, total: list.length, date: targetDate };
}
