// ============================================================================
// lib/cron-helpers.ts — shared cron utilities, v2. Typed against the client.
// Key change from v1: calling-hours is ALWAYS per-clinic (no hardcoded
// America/Vancouver). Keeps the good v1 ideas: cron logging, 24h contact
// dedup, idempotency locks, waitlist expiry.
// ============================================================================
import { db } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";

// ---- cron run logging ----
export async function startCronLog(name: string): Promise<string | null> {
  const { data } = await db()
    .from("cron_logs")
    .insert({ cron_name: name, status: "running" })
    .select("id")
    .maybeSingle();
  return data?.id ?? null;
}

export async function completeCronLog(id: string | null, result: Json): Promise<void> {
  if (!id) return;
  await db().from("cron_logs")
    .update({ status: "success", completed_at: new Date().toISOString(), result })
    .eq("id", id);
}

export async function failCronLog(id: string | null, error: string): Promise<void> {
  if (!id) return;
  await db().from("cron_logs")
    .update({ status: "failed", completed_at: new Date().toISOString(), error })
    .eq("id", id);
}

// ---- per-clinic calling hours (no hardcoded timezone) ----
export function isWithinCallingHours(timezone: string, force = false): boolean {
  if (force) return true;
  try {
    const local = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
    const hour = local.getHours();
    const day = local.getDay(); // 0=Sun
    if (day === 0) return false;
    if (day >= 1 && day <= 5) return hour >= 9 && hour < 20;
    if (day === 6) return hour >= 10 && hour < 17;
    return false;
  } catch {
    return false;
  }
}

// ---- 24h contact dedup ----
export async function wasContactedRecently(
  clinicId: string,
  phone: string,
  withinHours = 24,
): Promise<boolean> {
  const { data } = await db()
    .from("patients")
    .select("last_contacted_at")
    .eq("clinic_id", clinicId)
    .eq("phone", phone)
    .maybeSingle();
  if (!data?.last_contacted_at) return false;
  const hours = (Date.now() - new Date(data.last_contacted_at).getTime()) / 3_600_000;
  return hours < withinHours;
}

export async function markContacted(clinicId: string, phone: string): Promise<void> {
  await db().from("patients")
    .update({ last_contacted_at: new Date().toISOString() })
    .eq("clinic_id", clinicId)
    .eq("phone", phone);
}

// ---- idempotency lock: claim a one-time action by stamping a null field ----
// Returns true only for the caller that wins the claim (field was null).
export async function claimBookingField(
  bookingId: string,
  field: "reminder_sent_at" | "review_sent_at" | "followup_sent_at" | "no_show_at" | "reappointment_sent_at",
): Promise<boolean> {
  const { data } = await db()
    .from("bookings")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ [field]: new Date().toISOString() } as never)
    .eq("id", bookingId)
    .is(field, null)
    .select("id")
    .maybeSingle();
  return !!data;
}

export function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
