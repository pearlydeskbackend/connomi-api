// ============================================================================
// config/app.ts — brand + product constants. The single home for every name,
// label, and tunable number that used to be sprinkled through the code as
// magic values. Change the brand once, here.
//
// Per-clinic values (hours, timezone, review link, agent display name) do NOT
// live here — they live in the `clinics` table and are read at runtime. This
// file is only for platform-level constants that are the same for everyone.
// ============================================================================

export const BRAND = {
  product: "Connomi AI",
  /**
   * FALLBACK agent name only. The real name is per-clinic: clinics.agent_name.
   * Always read as `clinic.agent_name ?? BRAND.agentName` so a clinic that has
   * chosen a custom name gets it, and one that hasn't falls back to this.
   */
  agentName: "Sophie",
  supportEmail: "support@connomi.com",
} as const;

// Rate limiting (per-IP / per-key, in-memory window)
export const RATE_LIMIT = {
  max: 10,
  windowMs: 60_000,
  sweepMs: 5 * 60_000,
} as const;

// Outbound-call retry / SMS retry
export const RETRY = {
  smsTransientDelayMs: 1_000,
  bookingInsertTimeoutMs: 8_000,
} as const;

// Waitlist / recall cadence
export const CADENCE = {
  maxCallAttempts: 3,
  recallMonths: 6,
  reengagementMonths: 12,
  waitlistDefaultExpiryDays: 30,
} as const;

// Booking guardrails
export const BOOKING = {
  maxFutureMonths: 12,
} as const;

// Reminders: services valuable enough to warrant a voice call on top of SMS
export const HIGH_VALUE_SERVICES = [
  "root canal", "crown", "extraction", "implant",
  "surgery", "wisdom tooth", "bone graft", "bridge",
] as const;

// Reviews: send N days after a completed visit; suppress if a complaint/
// unresolved call occurred within +/- this many days of the visit.
export const REVIEWS = {
  daysAfterVisit: 3,
  complaintWindowDays: 3,
} as const;

// E.164 validation (used before any outbound call / SMS)
export const E164 = /^\+[1-9]\d{7,14}$/;
