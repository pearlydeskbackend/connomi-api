// ============================================================================
// lib/validators.ts — Zod schemas. Keeps the v1 sanitization (anti-XSS / SMS
// injection) but speaks v2: a single ISO `startsAt` timestamp instead of
// separate date/time text fields. Vapi sends the patient's intent; we validate
// and hand clean data to book_appointment.
// ============================================================================
import { z } from "zod";
import { BOOKING } from "@/config/app";

// ---- sanitization (unchanged from v1 — it was good) ----
function sanitizeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[<>'"`;]/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .trim();
}

// ---- shared fields ----
const patientName = z
  .string()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name too long")
  .trim()
  .transform(sanitizeText)
  .refine((v) => v.length >= 2, "Name too short after sanitization");

const patientPhone = z.string().min(7).max(20).trim();

const serviceField = z.string().min(1).max(100).trim().transform(sanitizeText);

const notesField = z
  .string()
  .max(500)
  .trim()
  .transform(sanitizeText)
  .optional()
  .default("");

// ISO timestamp, must be in the future and within the booking horizon.
const startsAt = z
  .string()
  .datetime({ offset: true, message: "startsAt must be an ISO timestamp with offset" })
  .refine((iso) => {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    const now = Date.now();
    const max = now + BOOKING.maxFutureMonths * 31 * 24 * 60 * 60 * 1000;
    return t >= now && t <= max;
  }, `Appointment must be in the future and within ${BOOKING.maxFutureMonths} months`);

const isNewPatient = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === "true");

// ---- schemas ----
export const BookingSchema = z.object({
  patientName,
  patientPhone,
  service: serviceField,
  startsAt,
  providerId: z.string().uuid().optional(),
  isNewPatient,
  notes: notesField,
});
export type BookingInput = z.infer<typeof BookingSchema>;

export const CancelSchema = z.object({ patientName, patientPhone });

export const RescheduleSchema = z.object({
  patientName,
  patientPhone,
  newStartsAt: startsAt,
});

export const AvailabilitySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  service: serviceField.optional(),
  providerId: z.string().uuid().optional(),
});

export const WaitlistSchema = z.object({
  patientName,
  patientPhone,
  service: z.string().max(100).trim().transform(sanitizeText).optional().default("Teeth cleaning"),
  preferredDays: z.string().max(100).trim().transform(sanitizeText).optional(),
  preferredTimes: z.string().max(100).trim().transform(sanitizeText).optional(),
});

export const MessageSchema = z.object({
  patientName: patientName.optional(),
  patientPhone: patientPhone.optional(),
  message: z.string().min(1).max(1000).trim().transform(sanitizeText),
  urgency: z.enum(["routine", "urgent", "emergency"]).default("routine"),
});
