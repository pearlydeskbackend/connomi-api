// ============================================================================
// lib/jobs/waitlist-maintenance.ts — housekeeping for the waitlist system.
// 1) expire entries past expires_at  2) reset stale 'offered' entries back to
// 'waiting' so they can be retried  3) expire cancelled_slots whose time passed.
// ============================================================================
import { db } from "@/lib/supabase";
import { CADENCE } from "@/config/app";

export interface MaintenanceResult { expired: number; reset: number; slotsExpired: number; }

export async function runWaitlistMaintenance(): Promise<MaintenanceResult> {
  const now = new Date().toISOString();

  // 1) expire entries past their expiry
  const { data: expiredRows } = await db()
    .from("waitlist")
    .update({ status: "expired" })
    .eq("status", "waiting")
    .lt("expires_at", now)
    .select("id");
  const expired = expiredRows?.length ?? 0;

  // 2) reset stale 'offered' (no response within 5 min) back to waiting, if
  //    under the attempt cap, so another cascade pass can retry them
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: stale } = await db()
    .from("waitlist")
    .select("id, attempts")
    .eq("status", "offered")
    .lt("last_attempt_at", fiveMinAgo)
    .lt("attempts", CADENCE.maxCallAttempts);
  let reset = 0;
  for (const entry of stale ?? []) {
    await db().from("waitlist").update({ status: "waiting" }).eq("id", entry.id);
    reset++;
  }

  // 3) expire open slots whose start time has passed
  const { data: passed } = await db()
    .from("cancelled_slots")
    .update({ status: "expired" })
    .eq("status", "open")
    .lt("starts_at", now)
    .select("id");
  const slotsExpired = passed?.length ?? 0;

  return { expired, reset, slotsExpired };
}
