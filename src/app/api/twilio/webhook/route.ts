import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { getClinicByPhone } from '@/lib/clinic'
import { sendSMS, smsCancellation } from '@/lib/twilio'
import { formatPhone } from '@/lib/phone'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const twiml   = '<?xml version="1.0"?><Response></Response>'
  const headers = { 'Content-Type': 'text/xml' }

  try {
    const formData = await req.formData()
    const from     = formData.get('From') as string
    const to       = formData.get('To') as string
    const rawBody  = formData.get('Body') as string
    const message  = rawBody?.trim().toLowerCase() || ''

    if (!from || !to || !rawBody) return new NextResponse(twiml, { headers })

    const clinic = await getClinicByPhone(to)
    if (!clinic) return new NextResponse(twiml, { headers })

    const phone       = formatPhone(from) || from
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    const today       = new Date().toISOString().split('T')[0]

    // ── CONFIRM ──────────────────────────────────────────────────
    if (['confirm', 'c', 'confirmed'].includes(message)) {
      const { data: booking } = await supabase
        .from('bookings')
        .select('*')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['Confirmed'])
        .gte('date', today)
        .order('date', { ascending: true })
        .limit(1)
        .single()

      if (booking) {
        await supabase
          .from('bookings')
          .update({
            status:     'Patient Confirmed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', booking.id)

        await sendSMS(
          from,
          `Confirmed! See you on ${booking.date} at ${booking.time} at ${clinic.name}. If anything changes call ${clinicPhone}.`
        )

        console.log(`[webhook] ${booking.patient_name} confirmed for ${booking.date} ${booking.time}`)
      } else {
        await sendSMS(
          from,
          `Thanks! We look forward to seeing you. Questions? Call ${clinicPhone}.`
        )
      }
    }

    // ── YES — could be confirm OR recall reply ────────────────────
    else if (['yes', 'y'].includes(message)) {
      // First check if they have an upcoming booking to confirm
      const { data: booking } = await supabase
        .from('bookings')
        .select('*')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['Confirmed'])
        .gte('date', today)
        .order('date', { ascending: true })
        .limit(1)
        .single()

      if (booking) {
        // They have an upcoming booking — treat YES as confirm
        await supabase
          .from('bookings')
          .update({
            status:     'Patient Confirmed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', booking.id)

        await sendSMS(
          from,
          `Confirmed! See you on ${booking.date} at ${booking.time} at ${clinic.name}. If anything changes call ${clinicPhone}.`
        )

        console.log(`[webhook] ${booking.patient_name} confirmed via YES for ${booking.date} ${booking.time}`)
      } else {
        // No upcoming booking — they are replying YES to a recall SMS
        await sendSMS(
          from,
          `Great! We will have Pearly call you shortly to get you booked in at ${clinic.name}. Expect a call in the next few minutes!`
        )

        // Mark patient for immediate recall callback
        await supabase
          .from('patients')
          .update({
            recall_status:          'pending',
            recall_next_attempt_at: new Date().toISOString(),
            recall_sequence_step:   0,
            updated_at:             new Date().toISOString(),
          })
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)

        console.log(`[webhook] ${phone} replied YES to recall — queued for immediate callback`)
      }
    }

    // ── CANCEL ───────────────────────────────────────────────────
    else if (['cancel', 'no', 'n', 'stop booking', 'cancel appointment'].includes(message)) {
      const { data: booking } = await supabase
        .from('bookings')
        .select('*')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['Confirmed', 'Patient Confirmed'])
        .gte('date', today)
        .order('date', { ascending: true })
        .limit(1)
        .single()

      if (booking) {
        await supabase
          .from('bookings')
          .update({
            status:       'Cancelled',
            cancelled_at: new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          })
          .eq('id', booking.id)

        await sendSMS(
          from,
          smsCancellation(
            booking.patient_name, booking.service,
            booking.date, booking.time,
            clinic.name, clinicPhone
          )
        )

        console.log(`[webhook] ${booking.patient_name} cancelled via SMS`)

        // Trigger waitlist fill if slot is more than 2 hours away
        const slotDateTime   = new Date(`${booking.date}T12:00:00`)
        const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60)

        if (hoursUntilSlot > 2) {
          const { data: slotRecord } = await supabase
            .from('cancelled_slots')
            .insert({
              clinic_id:  clinic.id,
              booking_id: booking.id,
              service:    booking.service,
              slot_date:  booking.date,
              slot_time:  booking.time,
              status:     'open',
            })
            .select()
            .single()

          if (slotRecord) {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'
            fetch(`${appUrl}/api/internal/fill-slot`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-secret': process.env.CRON_SECRET || '',
              },
              body: JSON.stringify({ slotId: slotRecord.id }),
            }).catch(err => console.error('[webhook] Fill trigger error:', err))
          }
        }
      } else {
        await sendSMS(
          from,
          `We could not find an upcoming booking under this number. Call ${clinicPhone} for help.`
        )
      }
    }

    // ── UNSUBSCRIBE / OPT OUT ────────────────────────────────────
    else if (['stop', 'unsubscribe', 'quit', 'end'].includes(message)) {
      if (phone) {
        // Mark patient as opted out of recall — permanent
        await supabase
          .from('patients')
          .update({
            recall_status:          'opted_out',
            recall_next_attempt_at: null,
            updated_at:             new Date().toISOString(),
          })
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)

        await sendSMS(
          from,
          `You have been removed from our recall list at ${clinic.name}. Call us anytime at ${clinicPhone} when you are ready to book.`
        )

        console.log(`[webhook] ${phone} opted out of recall`)
      }
    }

    // ── ANYTHING ELSE → save as unread message ───────────────────
    else {
      await supabase.from('messages').insert({
        clinic_id:    clinic.id,
        patient_name: 'SMS Reply',
        phone,
        message:      rawBody,
        urgency:      'routine',
        status:       'unread',
        source:       'sms',
        created_at:   new Date().toISOString(),
      })

      await sendSMS(
        from,
        `Thanks for your message. We will get back to you shortly or call ${clinicPhone}.`
      )
    }

    return new NextResponse(twiml, { headers })
  } catch (err) {
    console.error('[twilio/webhook] Error:', err)
    return new NextResponse(twiml, { headers })
  }
}