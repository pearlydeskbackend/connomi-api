import { z } from 'zod'

// ─── SANITIZATION HELPERS ─────────────────────────────────────────────────────

// Strip HTML tags and dangerous characters from text fields
// Prevents XSS in dashboard and SMS injection
function sanitizeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/[<>'"`;]/g, '')          // strip dangerous chars
    .replace(/javascript:/gi, '')      // strip JS protocol
    .replace(/on\w+\s*=/gi, '')        // strip event handlers
    .trim()
}

// Validate date is not in the past and not more than 12 months out
function validateBookingDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date      = new Date(y, m - 1, d)
  const today     = new Date()
  today.setHours(0, 0, 0, 0)

  const maxDate = new Date()
  maxDate.setFullYear(maxDate.getFullYear() + 1)

  return date >= today && date <= maxDate
}

// ─── SHARED REFINEMENTS ───────────────────────────────────────────────────────

const patientName = z
  .string()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name too long')
  .trim()
  .transform(sanitizeText)
  .refine(v => v.length >= 2, 'Name must be at least 2 characters after sanitization')

const patientPhone = z
  .string()
  .min(7, 'Phone number too short')
  .max(20, 'Phone number too long')
  .trim()

const serviceField = z
  .string()
  .min(1)
  .max(100)
  .trim()
  .transform(sanitizeText)

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format')
  .refine(validateBookingDate, 'Date must be today or in the future and within 12 months')

const timeField = z
  .string()
  .min(4)
  .max(10)
  .trim()
  .refine(v => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(v), 'Time must be in h:mm AM/PM format')

const notesField = z
  .string()
  .max(500)
  .trim()
  .transform(sanitizeText)
  .optional()
  .default('')

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────

export const BookingSchema = z.object({
  patientName,
  patientPhone,
  service:      serviceField,
  date:         dateField,
  time:         timeField,
  isNewPatient: z.union([z.boolean(), z.string()]).optional().transform(v =>
    v === 'true' || v === true
  ),
  notes: notesField,
})

export const CancelSchema = z.object({
  patientName,
  patientPhone,
})

export const RescheduleSchema = z.object({
  patientName,
  patientPhone,
  newDate: dateField,
  newTime: timeField,
})

export const WaitlistSchema = z.object({
  patientName,
  patientPhone,
  service:        z.string().max(100).trim().transform(sanitizeText).optional().default('Teeth cleaning'),
  preferredDays:  z.string().max(100).trim().transform(sanitizeText).optional(),
  preferredTimes: z.string().max(100).trim().transform(sanitizeText).optional(),
})

export const MessageSchema = z.object({
  patientName:  patientName.optional(),
  patientPhone: patientPhone.optional(),
  message:      z.string().min(1).max(1000).trim().transform(sanitizeText),
  urgency:      z.enum(['routine', 'urgent', 'emergency']).default('routine'),
})

export const AvailabilitySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})