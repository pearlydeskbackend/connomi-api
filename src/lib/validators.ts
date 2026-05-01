import { z } from 'zod'

export const BookingSchema = z.object({
  patientName:  z.string().min(2).max(100).trim(),
  patientPhone: z.string().min(7).max(20),
  service:      z.string().min(1),
  date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:         z.string().min(4).max(10),
  isNewPatient: z.union([z.boolean(), z.string()]).optional().transform(v =>
    v === 'true' || v === true
  ),
  notes: z.string().max(500).optional().default(''),
})

export const CancelSchema = z.object({
  patientName:  z.string().min(2).max(100).trim(),
  patientPhone: z.string().min(7).max(20),
})

export const RescheduleSchema = z.object({
  patientName:  z.string().min(2).max(100).trim(),
  patientPhone: z.string().min(7).max(20),
  newDate:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  newTime:      z.string().min(4).max(10),
})

export const WaitlistSchema = z.object({
  patientName:    z.string().min(2).max(100).trim(),
  patientPhone:   z.string().min(7).max(20),
  service:        z.string().max(100).optional().default('Teeth cleaning'),
  preferredDays:  z.string().max(100).optional(),
  preferredTimes: z.string().max(100).optional(),
})

export const MessageSchema = z.object({
  patientName:  z.string().min(1).max(100).trim().optional(),
  patientPhone: z.string().min(7).max(20).optional(),
  message:      z.string().min(1).max(1000).trim(),
  urgency:      z.enum(['routine', 'urgent', 'emergency']).default('routine'),
})

export const AvailabilitySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})