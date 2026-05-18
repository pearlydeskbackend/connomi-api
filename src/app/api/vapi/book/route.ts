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

    // ── DUPLICATE BOOKING CHECK ───────────────────────────────────
    // Use maybeSingle() — never throws when no rows found
    const { data: existing } = await supabase
      .from('bookings')
      .select('id, date, time, service')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .in('status', ['Confirmed', 'Patient Confirmed'])
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (existing) {
      return vapiSuccess(
        toolCallId,
        `I can see you already have a ${existing.service} booked for ${existing.date} at ${existing.time}. Would you like to keep that, reschedule it, or book an additional appointment?`
      )
    }

    // ── SLOT CONFLICT CHECK ───────────────────────────────────────
    // Never double book the same slot
    const { data: slotConflict } = await supabase
      .from('bookings')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('date', date)
      .eq('time', time)
      .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])
      .limit(1)
      .maybeSingle()

    if (slotConflict) {
      return vapiError(
        toolCallId,
        `I am sorry, that slot at ${time} on ${date} was just taken. Let me find you the next available time.`
      )
    }

    // ── INSERT BOOKING ────────────────────────────────────────────
    const { data: booking, error: bookingError } = await Promise.race([
      supabase
        .from('bookings')
        .insert({
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
        })
        .select()
        .single(),
      new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Insert timed out') }), 8000)
      ),
    ]) as { data: any; error: Error | null }

    if (bookingError || !booking) {
      console.error('[book] Insert error:', bookingError?.message)
      return vapiError(toolCallId, 'I am having trouble completing that booking. Please call us directly.')
    }

    // ── UPSERT PATIENT RECORD ─────────────────────────────────────
    // Fire and forget — never block the response
    Promise.resolve(
      supabase
        .from('patients')
        .upsert(
          {
            clinic_id:    clinic.id,
            patient_name: patientName,
            phone,
            updated_at:   new Date().toISOString(),
          },
          { onConflict: 'clinic_id,phone' }
        )
    ).catch((err: unknown) => console.error('[book] Patient upsert error:', err))

    // ── CONFIRMATION SMS ──────────────────────────────────────────
    // Fire and forget — never block the response
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    sendSMS(
      phone,
      smsConfirmation(patientName, service, date, time, clinic.name, clinicPhone, isNewPatient)
    ).catch((err: unknown) => console.error('[book] SMS error:', err))

    // ── WAITLIST LOOP CLOSE ───────────────────────────────────────
    // Check if this booking fills an open cancelled slot
    // Fire and forget — never block the response
    closeWaitlistLoop(booking.id, clinic, phone, patientName, service, date, time, clinicPhone)
      .catch(err => console.error('[book] Waitlist loop error:', err))

    console.log(`[book] Booking saved — ${patientName} ${service} ${date} at ${time} — ${clinic.name} (new: ${isNewPatient})`)

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
): Promise<void> {
  try {
    // Find an open cancelled slot matching this date + time
    // Use maybeSingle() — never throws when no rows found
    const { data: openSlot } = await supabase
      .from('cancelled_slots')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('slot_date', date)
      .eq('slot_time', time)
      .in('status', ['open', 'processing'])
      .limit(1)
      .maybeSingle()

    if (!openSlot) return // normal booking — not a waitlist fill

    const now = new Date().toISOString()

    // Mark slot as filled
    await supabase
      .from('cancelled_slots')
      .update({
        status:    'filled',
        filled_at: now,
      })
      .eq('id', openSlot.id)

    // Expire all pending queue jobs for this slot
    await supabase
      .from('waitlist_call_queue')
      .update({ status: 'expired', outcome: 'slot_filled_direct_booking' })
      .eq('slot_id', openSlot.id)
      .in('status', ['pending', 'calling', 'called'])

    // Find the waitlist entry for this patient
    // Check called OR waiting — patient may have booked via direct call
    const { data: waitlistEntry } = await supabase
      .from('waitlist')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .in('status', ['called', 'waiting'])
      .order('last_attempt_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (waitlistEntry) {
      await supabase
        .from('waitlist')
        .update({
          status:             'booked',
          booked_at:          now,
          matched_booking_id: bookingId,
        })
        .eq('id', waitlistEntry.id)

      await supabase
        .from('cancelled_slots')
        .update({ filled_by_waitlist_id: waitlistEntry.id })
        .eq('id', openSlot.id)

      await supabase
        .from('waitlist_attempts')
        .update({ outcome: 'booked' })
        .eq('waitlist_id', waitlistEntry.id)
        .eq('outcome', 'calling')
    }

    // Alert owner
    const ownerPhone = clinic.owner_phone || clinic.twilio_phone
    if (ownerPhone) {
      sendSMS(
        ownerPhone,
        `Pearly filled your ${service} slot on ${date} at ${time}. ${patientName} from the waitlist is now booked and confirmed. — Pearly Desk`
      ).catch(err => console.error('[book] Owner SMS error:', err))
    }

    console.log(`[book] Waitlist loop closed — ${patientName} filled ${service} slot on ${date} at ${time}`)

  } catch (err) {
    console.error('[book] closeWaitlistLoop error:', err)
  }
}