// ============================================================================
// lib/lookup.ts — shared read helpers used by cancel/reschedule/confirm.
// Centralizes "find this patient's next upcoming booking" so the matching
// logic (normalized phone + live statuses + future only) is defined once.
// ============================================================================
import { db, type Booking } from "@/lib/supabase";
import type { Enums } from "@/lib/database.types";

const LIVE_STATUSES: Enums<"booking_status">[] = ["scheduled", "confirmed"];

/** the patient's soonest upcoming, non-cancelled booking at this clinic */
export async function findNextBooking(
  clinicId: string,
  normalizedPhone: string,
): Promise<Booking | null> {
  const { data, error } = await db()
    .from("bookings")
    .select("*")
    .eq("clinic_id", clinicId)
    .eq("phone", normalizedPhone)
    .in("status", LIVE_STATUSES)
    .is("deleted_at", null)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[lookup] findNextBooking:", error.message);
    return null;
  }
  return data;
}
