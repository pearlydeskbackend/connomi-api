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
        .maybeSingle()

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

    // ── YES ───────────────────────────────────────────────────────
    // Priority order:
    //   1. Waitlist slot offer reply (60 min window)
    //   2. Upcoming booking confirmation
    //   3. Recall callback request
    else if (['yes', 'y'].includes(message)) {

      // ── CHECK WAITLIST OFFER FIRST ────────────────────────────
      // Patient may be replying YES to a waitlist slot SMS
      // Window is 60 minutes — gives patient time to see the message
      const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const { data: recentJob } = await supabase
        .from('waitlist_call_queue')
        .select('*')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .eq('method', 'sms')
        .in('status', ['called', 'calling'])
        .gte('attempted_at', sixtyMinutesAgo)
        .order('attempted_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (recentJob) {
        console.log(`[webhook] ${phone} replied YES to waitlist SMS for slot ${recentJob.slot_id}`)

        // Atomically claim the slot — prevents race conditions
        const { data: slotClaimed } = await supabase
          .from('cancelled_slots')
          .update({
            status:        'processing',
            processing_at: new Date().toISOString(),
          })
          .eq('id', recentJob.slot_id)
          .eq('status', 'open')
          .select()
          .maybeSingle()

        if (!slotClaimed) {
          // Slot was just taken by someone else
          await sendSMS(
            from,
            `Sorry — that slot was just taken by another patient. We will keep you on the waitlist and call when the next one opens. — ${clinic.name}`
          )
          console.log(`[webhook] Slot ${recentJob.slot_id} already taken when ${phone} replied YES`)
        } else {
          // Slot claimed — create the booking
          const now = new Date().toISOString()

          const { error: bookingError } = await supabase
            .from('bookings')
            .insert({
              clinic_id:    clinic.id,
              patient_name: recentJob.patient_name,
              phone,
              service:      recentJob.service,
              date:         recentJob.slot_date,
              time:         recentJob.slot_time,
              status:       'Confirmed',
              booked_by:    'waitlist',
              created_at:   now,
              updated_at:   now,
            })

          if (bookingError) {
            console.error('[webhook] Waitlist booking error:', bookingError.message)
            // Release slot on failure
            await supabase
              .from('cancelled_slots')
              .update({ status: 'open', processing_at: null })
              .eq('id', recentJob.slot_id)

            await sendSMS(
              from,
              `Sorry, we had trouble booking that slot. Please call ${clinicPhone} directly.`
            )
          } else {
            // Mark slot filled
            const fillMinutes = Math.round(
              (Date.now() - new Date(slotClaimed.cancelled_at).getTime()) / (1000 * 60)
            )

            await supabase
              .from('cancelled_slots')
              .update({
                status:                'filled',
                filled_at:             now,
                filled_in_minutes:     fillMinutes,
                filled_by_waitlist_id: recentJob.waitlist_id,
              })
              .eq('id', recentJob.slot_id)

            // Mark waitlist entry as booked
            await supabase
              .from('waitlist')
              .update({ status: 'booked', booked_at: now })
              .eq('id', recentJob.waitlist_id)

            // Mark queue job as booked
            await supabase
              .from('waitlist_call_queue')
              .update({ status: 'booked', outcome: 'booked_via_sms' })
              .eq('id', recentJob.id)

            // Expire all other pending jobs for this slot
            await supabase
              .from('waitlist_call_queue')
              .update({ status: 'expired', outcome: 'slot_filled_by_other' })
              .eq('slot_id', recentJob.slot_id)
              .in('status', ['pending', 'calling', 'called'])
              .neq('id', recentJob.id)

            // Confirm to patient
            await sendSMS(
              from,
              `You are booked! ${recentJob.service} on ${recentJob.slot_date} at ${recentJob.slot_time} at ${clinic.name}. See you then! Questions? Call ${clinicPhone}.`
            )

            // Alert owner
            const ownerPhone = clinic.owner_phone || clinic.twilio_phone
            if (ownerPhone) {
              sendSMS(
                ownerPhone,
                `Pearly filled your ${recentJob.service} slot on ${recentJob.slot_date} at ${recentJob.slot_time} in ${fillMinutes} min. ${recentJob.patient_name} booked via SMS reply. — Pearly Desk`
              ).catch(err => console.error('[webhook] Owner SMS error:', err))
            }

            console.log(`[webhook] ${recentJob.patient_name} booked via YES SMS reply — ${recentJob.service} ${recentJob.slot_date}`)
          }
        }

      } else {
        // No recent waitlist offer — check for upcoming booking to confirm
        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)
          .in('status', ['Confirmed'])
          .gte('date', today)
          .order('date', { ascending: true })
          .limit(1)
          .maybeSingle()

        if (booking) {
          // Treat YES as appointment confirmation
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
          // No booking — treat as recall reply
          await sendSMS(
            from,
            `Great! We will have Pearly call you shortly to get you booked in at ${clinic.name}. Expect a call in the next few minutes!`
          )

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

          console.log(`[webhook] ${phone} replied YES to recall — queued for callback`)
        }
      }
    }

    // ── CANCEL ───────────────────────────────────────────────────
    else if (['cancel', 'no', 'n', 'stop booking', 'cancel appointment'].includes(message)) {

      // First check if this is a NO to a waitlist offer
      const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const { data: recentJob } = await supabase
        .from('waitlist_call_queue')
        .select('*')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .eq('method', 'sms')
        .in('status', ['called', 'calling'])
        .gte('attempted_at', sixtyMinutesAgo)
        .order('attempted_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (recentJob) {
        // Patient declined the waitlist slot
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'declined', outcome: 'patient_declined_sms' })
          .eq('id', recentJob.id)

        // Increment declined count — affects future scoring
        await supabase.rpc('increment_declined', { row_id: recentJob.waitlist_id })

        await supabase
          .from('waitlist')
          .update({
            status:           'waiting', // keep on waitlist for next slot
            last_declined_at: new Date().toISOString(),
          })
          .eq('id', recentJob.waitlist_id)

        await sendSMS(
          from,
          `No problem! We will keep you on the waitlist and reach out when the next slot opens. — ${clinic.name}`
        )

        console.log(`[webhook] ${phone} declined waitlist slot via SMS`)

      } else {
        // Regular cancellation
        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)
          .in('status', ['Confirmed', 'Patient Confirmed'])
          .gte('date', today)
          .order('date', { ascending: true })
          .limit(1)
          .maybeSingle()

        if (booking) {
          const now = new Date().toISOString()

          await supabase
            .from('bookings')
            .update({
              status:       'Cancelled',
              cancelled_at: now,
              updated_at:   now,
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
          const slotDateTime   = new Date(`${booking.date}T${convertTo24h(booking.time)}`)
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
              .maybeSingle()

            if (slotRecord) {
              const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'
              fetch(`${appUrl}/api/internal/fill-slot`, {
                method:  'POST',
                headers: {
                  'Content-Type':      'application/json',
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
    }

    // ── UNSUBSCRIBE / OPT OUT ─────────────────────────────────────
    else if (['stop', 'unsubscribe', 'quit', 'end'].includes(message)) {
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

    // ── ANYTHING ELSE → save as unread message ────────────────────
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

function convertTo24h(time: string): string {
  const match = time.match(/(\d+):(\d+)\s*(AM|PM)/i)
  if (!match) return '12:00:00'
  let hour = parseInt(match[1])
  const min = match[2]
  const period = match[3].toUpperCase()
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${min}:00`
}