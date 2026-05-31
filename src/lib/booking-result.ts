// ============================================================================
// lib/booking-result.ts — TS mirror of book_appointment()'s jsonb return.
// Keeping it in one place means every caller branches on the same typed union.
// ============================================================================
export type BookFailureReason =
  | "clinic_not_found"
  | "clinic_closed"
  | "outside_hours"
  | "too_soon"
  | "no_provider"
  | "slot_taken";

export type BookResult =
  | {
      ok: true;
      booking_id: string;
      patient_id: string;
      provider_id: string;
      starts_at: string;
      ends_at: string;
    }
  | { ok: false; reason: BookFailureReason };
