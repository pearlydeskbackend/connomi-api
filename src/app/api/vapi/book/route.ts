import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsConfirmation } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { BookingSchema } from '@/lib/validators'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: 'I am having trouble with our system. Please call us directly at 604-879-9999.' }]
      })
    }

    toolCallId = tool.toolCallId

    const validation = BookingSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'I am missing some details. Could you give me your full name, phone number, the service, date and time?')
    }

    const { patientName, patientPhone, service, date, time, isNewPatient, notes } = validation.data

    const phone = formatPhone(patientPhone)
    if (!phone) {
      return vapiError(toolCallId, 'I could not verify that phone number. Could you repeat it slowly?')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I am having trouble with our system. Please call us directly.')
    }

    const today = new Date().toISOString().split('T')[0]

    // Check for duplicate upcoming booking
    const { data: existing } = await supabase
      .from('bookings')
      .select('id, date, time, service')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .eq('status', 'Confirmed')
      .gte('date', today)
      .limit(1)
      .single()

    if (existing) {
      return vapiSuccess(
        toolCallId,
        `I can see you already have a ${existing.service} booked for ${existing.date} at ${existing.time}. Would you like to keep that, reschedule it, or book an additional appointment?`
      )
    }

    // Insert booking
    const { data: booking, error: bookingError } = await Promise.race([
      supabase.from('bookings').insert({
        clinic_id:      clinic.id,
        patient_name:   patientName,
        phone,
        service,
        date,
        time,
        status:         'Confirmed',
        is_new_patient: isNewPatient,
        booked_by:      'pearly',
        notes,
        created_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }).select().single(),
      new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Insert timed out') }), 8000)
      ),
    ]) as { data: any; error: Error | null }

    if (bookingError) {
      console.error('[book] Insert error:', bookingError.message)
      return vapiError(toolCallId, 'I am having trouble completing that booking. Please call us directly.')
    }

   // Upsert patient record — fire and forget
Promise.resolve(
  supabase.from('patients').upsert(
    {
      clinic_id:    clinic.id,
      patient_name: patientName,
      phone,
      updated_at:   new Date().toISOString(),
    },
    { onConflict: 'clinic_id,phone' }
      )
    ).catch((err: unknown) => console.error('[book] Patient upsert error:', err))

    // Send confirmation SMS — fire and forget
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    sendSMS(
      phone,
      smsConfirmation(patientName, service, date, time, clinic.name, clinicPhone, isNewPatient)
    ).catch((err: unknown) => console.error('[book] SMS error:', err))

    // ─── WAITLIST SLOT CLOSING LOOP ───────────────────────────────
    // Check if this booking fills an open cancelled slot
    // Run after response is returned — fire and forget
    if (booking) {
      closeWaitlistLoop(booking.id, clinic, phone, patientName, service, date, time, clinicPhone)
        .catch(err => console.error('[book] Waitlist loop error:', err))
    }
    // ─────────────────────────────────────────────────────────────

    console.log(`[book] Booking saved — ${patientName} ${service} ${date} at ${clinic.name} (new: ${isNewPatient})`)

    return vapiSuccess(
      toolCallId,
      `You are all set! Your ${service} is booked for ${date} at ${time}. You will receive a confirmation text shortly. Is there anything else I can help you with?`
    )
  } catch (err) {
    console.error('[book] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}

async function closeWaitlistLoop(
  bookingId: string,
  clinic: any,
  phone: string,
  patientName: string,
  service: string,
  date: string,
  time: string,
  clinicPhone: string
) {
  // Find an open cancelled slot matching this date + time
  const { data: openSlot } = await supabase
    .from('cancelled_slots')
    .select('id')
    .eq('clinic_id', clinic.id)
    .eq('slot_date', date)
    .eq('slot_time', time)
    .eq('status', 'open')
    .single()

  if (!openSlot) return // not a waitlist fill — normal booking

  // Mark slot as filled
  await supabase
    .from('cancelled_slots')
    .update({
      status:    'filled',
      filled_at: new Date().toISOString(),
    })
    .eq('id', openSlot.id)

  // Find the waitlist entry for this patient
  const { data: waitlistEntry } = await supabase
    .from('waitlist')
    .select('id')
    .eq('clinic_id', clinic.id)
    .eq('phone', phone)
    .eq('status', 'called')
    .single()

  if (waitlistEntry) {
    // Mark waitlist patient as booked
    await supabase
      .from('waitlist')
      .update({
        status:             'booked',
        booked_at:          new Date().toISOString(),
        matched_booking_id: bookingId,
      })
      .eq('id', waitlistEntry.id)

    // Link slot to the waitlist entry
    await supabase
      .from('cancelled_slots')
      .update({ filled_by_waitlist_id: waitlistEntry.id })
      .eq('id', openSlot.id)

    // Update the attempt log to booked
    await supabase
      .from('waitlist_attempts')
      .update({ outcome: 'booked' })
      .eq('waitlist_id', waitlistEntry.id)
      .eq('outcome', 'calling')

    console.log(`[book] Waitlist slot filled — ${patientName} took ${service} on ${date} at ${time}`)
  }

  // Alert clinic owner that slot was auto-filled
  const ownerPhone = clinic.owner_phone || clinic.twilio_phone
  if (ownerPhone) {
    await sendSMS(
      ownerPhone,
      `Pearly filled your ${service} slot on ${date} at ${time}. ${patientName} from the waitlist has been booked and confirmed. — Pearly Desk`
    )
  }
}