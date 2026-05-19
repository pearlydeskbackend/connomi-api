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

    // ── STATUS ────────────────────────────────────────────────────
    // Patient texts "STATUS" → get their upcoming appointments
    if (['status', 'appointments', 'appt', 'booking'].includes(message)) {
      const { data: bookings } = await supabase
        .from('bookings')
        .select('patient_name, service, date, time, status')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['Confirmed', 'Patient Confirmed'])
        .gte('date', today)
        .order('date', { ascending: true })
        .limit(3)

      if (!bookings?.length) {
        await sendSMS(
          from,
          `You have no upcoming appointments at ${clinic.name}. To book call ${clinicPhone} or just reply BOOK.`
        )
      } else {
        const lines = [`Your upcoming appointments at ${clinic.name}:`, '']
        for (const b of bookings) {
          lines.push(`• ${b.service} — ${b.date} at ${b.time}`)
        }
        lines.push('', `To cancel reply CANCEL. Questions? Call ${clinicPhone}.`)
        await sendSMS(from, lines.join('\n'))
      }

      console.log(`[webhook] ${phone} checked status — ${bookings?.length || 0} bookings found`)
    }

    // ── WAITLIST command ──────────────────────────────────────────
    // Patient texts "WAITLIST cleaning" → join waitlist for that service
    else if (message.startsWith('waitlist')) {
      const service = rawBody.trim().slice(8).trim() || 'Teeth cleaning'

      // Check if already on waitlist
      const { data: existing } = await supabase
        .from('waitlist')
        .select('id, service')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['waiting', 'called'])
        .maybeSingle()

      if (existing) {
        await sendSMS(
          from,
          `You are already on the waitlist for ${existing.service} at ${clinic.name}. We will call as soon as a slot opens!`
        )
      } else {
        // Get patient name from patients table or bookings
        const { data: patient } = await supabase
          .from('patients')
          .select('patient_name')
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)
          .maybeSingle()

        const { data: lastBooking } = await supabase
          .from('bookings')
          .select('patient_name')
          .eq('clinic_id', clinic.id)
          .eq('phone', phone)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const patientName = patient?.patient_name || lastBooking?.patient_name || 'Patient'

        await supabase.from('waitlist').insert({
          clinic_id:     clinic.id,
          patient_name:  patientName,
          phone,
          service:       service,
          status:        'waiting',
          attempt_count: 0,
          declined_count: 0,
          priority:      5,
          added_at:      new Date().toISOString(),
          expires_at:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })

        await sendSMS(
          from,
          `You are on the waitlist for ${service} at ${clinic.name}! We will call you as soon as a slot opens. To remove yourself reply REMOVE.`
        )

        console.log(`[webhook] ${phone} joined waitlist for ${service} via SMS`)
      }
    }

    // ── REMOVE from waitlist ───────────────────────────────────────
    else if (['remove', 'removeme', 'remove me'].includes(message)) {
      const { data: entry } = await supabase
        .from('waitlist')
        .select('id, service')
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .in('status', ['waiting', 'called'])
        .maybeSingle()

      if (entry) {
        await supabase
          .from('waitlist')
          .update({ status: 'declined', deleted_at: new Date().toISOString() })
          .eq('id', entry.id)

        await sendSMS(
          from,
          `You have been removed from the waitlist for ${entry.service} at ${clinic.name}. Call ${clinicPhone} whenever you are ready to book.`
        )

        console.log(`[webhook] ${phone} removed from waitlist via SMS`)
      } else {
        await sendSMS(
          from,
          `You are not currently on the waitlist at ${clinic.name}. Call ${clinicPhone} if you need help.`
        )
      }
    }

    // ── HELP ──────────────────────────────────────────────────────
    else if (['help', 'menu', '?'].includes(message)) {
      await sendSMS(
        from,
        `${clinic.name} — text commands:\n\nSTATUS — see your appointments\nCONFIRM — confirm your next visit\nCANCEL — cancel your next visit\nWAITLIST [service] — join waitlist\nREMOVE — leave waitlist\nSTOP — opt out of all messages\n\nCall ${clinicPhone} for anything else.`
      )
    }

    // ── CONFIRM ───────────────────────────────────────────────────
    else if (['confirm', 'c', 'confirmed'].includes(message)) {
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
          .update({ status: 'Patient Confirmed', updated_at: new Date().toISOString() })
          .eq('id', booking.id)

        await sendSMS(
          from,
          `Confirmed! See you on ${booking.date} at ${booking.time} at ${clinic.name}. If anything changes call ${clinicPhone}.`
        )

        console.log(`[webhook] ${booking.patient_name} confirmed for ${booking.date} ${booking.time}`)
      } else {
        await sendSMS(from, `Thanks! We look forward to seeing you. Questions? Call ${clinicPhone}.`)
      }
    }

    // ── YES ───────────────────────────────────────────────────────
    else if (['yes', 'y'].includes(message)) {
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

        const { data: slotClaimed } = await supabase
          .from('cancelled_slots')
          .update({ status: 'processing', processing_at: new Date().toISOString() })
          .eq('id', recentJob.slot_id)
          .eq('status', 'open')
          .select()
          .maybeSingle()

        if (!slotClaimed) {
          await sendSMS(from, `Sorry — that slot was just taken. We will keep you on the waitlist and call when the next one opens. — ${clinic.name}`)
        } else {
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
            await supabase.from('cancelled_slots').update({ status: 'open', processing_at: null }).eq('id', recentJob.slot_id)
            await sendSMS(from, `Sorry, we had trouble booking that slot. Please call ${clinicPhone} directly.`)
          } else {
            const fillMinutes = Math.round((Date.now() - new Date(slotClaimed.cancelled_at).getTime()) / (1000 * 60))

            await supabase.from('cancelled_slots').update({
              status: 'filled', filled_at: now,
              filled_in_minutes: fillMinutes,
              filled_by_waitlist_id: recentJob.waitlist_id,
            }).eq('id', recentJob.slot_id)

            await supabase.from('waitlist').update({ status: 'booked', booked_at: now }).eq('id', recentJob.waitlist_id)
            await supabase.from('waitlist_call_queue').update({ status: 'booked', outcome: 'booked_via_sms' }).eq('id', recentJob.id)
            await supabase.from('waitlist_call_queue').update({ status: 'expired', outcome: 'slot_filled_by_other' })
              .eq('slot_id', recentJob.slot_id).in('status', ['pending', 'calling', 'called']).neq('id', recentJob.id)

            await sendSMS(from, `You are booked! ${recentJob.service} on ${recentJob.slot_date} at ${recentJob.slot_time} at ${clinic.name}. See you then! Call ${clinicPhone} with any questions.`)

            const ownerPhone = clinic.owner_phone || clinic.twilio_phone
            if (ownerPhone) {
              sendSMS(ownerPhone, `Pearly filled your ${recentJob.service} slot on ${recentJob.slot_date} at ${recentJob.slot_time} in ${fillMinutes} min. ${recentJob.patient_name} booked via SMS. — Pearly Desk`).catch(console.error)
            }

            console.log(`[webhook] ${recentJob.patient_name} booked via YES SMS — ${recentJob.service} ${recentJob.slot_date}`)
          }
        }
      } else {
        const { data: booking } = await supabase
          .from('bookings').select('*').eq('clinic_id', clinic.id).eq('phone', phone)
          .in('status', ['Confirmed']).gte('date', today).order('date', { ascending: true }).limit(1).maybeSingle()

        if (booking) {
          await supabase.from('bookings').update({ status: 'Patient Confirmed', updated_at: new Date().toISOString() }).eq('id', booking.id)
          await sendSMS(from, `Confirmed! See you on ${booking.date} at ${booking.time} at ${clinic.name}. If anything changes call ${clinicPhone}.`)
          console.log(`[webhook] ${booking.patient_name} confirmed via YES`)
        } else {
          await sendSMS(from, `Great! We will have Pearly call you shortly to get you booked in at ${clinic.name}.`)
          await supabase.from('patients').update({
            recall_status: 'pending', recall_next_attempt_at: new Date().toISOString(),
            recall_sequence_step: 0, updated_at: new Date().toISOString(),
          }).eq('clinic_id', clinic.id).eq('phone', phone)
          console.log(`[webhook] ${phone} replied YES to recall — queued for callback`)
        }
      }
    }

    // ── CANCEL / NO ───────────────────────────────────────────────
    else if (['cancel', 'no', 'n', 'stop booking', 'cancel appointment'].includes(message)) {
      const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const { data: recentJob } = await supabase
        .from('waitlist_call_queue').select('*').eq('clinic_id', clinic.id).eq('phone', phone)
        .eq('method', 'sms').in('status', ['called', 'calling']).gte('attempted_at', sixtyMinutesAgo)
        .order('attempted_at', { ascending: false }).limit(1).maybeSingle()

      if (recentJob) {
        await supabase.from('waitlist_call_queue').update({ status: 'declined', outcome: 'patient_declined_sms' }).eq('id', recentJob.id)
        await supabase.rpc('increment_declined', { row_id: recentJob.waitlist_id })
        await supabase.from('waitlist').update({ status: 'waiting', last_declined_at: new Date().toISOString() }).eq('id', recentJob.waitlist_id)
        await sendSMS(from, `No problem! We will keep you on the waitlist and reach out when the next slot opens. — ${clinic.name}`)
        console.log(`[webhook] ${phone} declined waitlist slot via SMS`)
      } else {
        const { data: booking } = await supabase
          .from('bookings').select('*').eq('clinic_id', clinic.id).eq('phone', phone)
          .in('status', ['Confirmed', 'Patient Confirmed']).gte('date', today)
          .order('date', { ascending: true }).limit(1).maybeSingle()

        if (booking) {
          const now = new Date().toISOString()
          await supabase.from('bookings').update({ status: 'Cancelled', cancelled_at: now, updated_at: now }).eq('id', booking.id)
          await sendSMS(from, smsCancellation(booking.patient_name, booking.service, booking.date, booking.time, clinic.name, clinicPhone))
          console.log(`[webhook] ${booking.patient_name} cancelled via SMS`)

          const slotDateTime   = new Date(`${booking.date}T${convertTo24h(booking.time)}`)
          const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60)

          if (hoursUntilSlot > 2) {
            const { data: slotRecord } = await supabase.from('cancelled_slots').insert({
              clinic_id: clinic.id, booking_id: booking.id, service: booking.service,
              slot_date: booking.date, slot_time: booking.time, status: 'open',
            }).select().maybeSingle()

            if (slotRecord) {
              const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'
              fetch(`${appUrl}/api/internal/fill-slot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.CRON_SECRET || '' },
                body: JSON.stringify({ slotId: slotRecord.id }),
              }).catch(err => console.error('[webhook] Fill trigger error:', err))
            }
          } else {
            // Last-minute cancel — alert owner immediately
            const ownerPhone = clinic.owner_phone || clinic.twilio_phone
            if (ownerPhone) {
              sendSMS(ownerPhone, `⚠️ Last-minute cancel: ${booking.patient_name} — ${booking.service} at ${booking.time} today. Not enough time to fill via waitlist. — Pearly Desk`).catch(console.error)
            }
          }
        } else {
          await sendSMS(from, `We could not find an upcoming booking under this number. Call ${clinicPhone} for help.`)
        }
      }
    }

    // ── UNSUBSCRIBE ───────────────────────────────────────────────
    else if (['stop', 'unsubscribe', 'quit', 'end'].includes(message)) {
      await supabase.from('patients').update({
        recall_status: 'opted_out', recall_next_attempt_at: null, updated_at: new Date().toISOString(),
      }).eq('clinic_id', clinic.id).eq('phone', phone)

      await sendSMS(from, `You have been removed from our recall list at ${clinic.name}. Call us anytime at ${clinicPhone} when you are ready to book.`)
      console.log(`[webhook] ${phone} opted out`)
    }

    // ── ANYTHING ELSE → save as message ──────────────────────────
    else {
      await supabase.from('messages').insert({
        clinic_id: clinic.id, patient_name: 'SMS Reply', phone,
        message: rawBody, urgency: 'routine', status: 'unread',
        source: 'sms', created_at: new Date().toISOString(),
      })

      await sendSMS(from, `Thanks for your message. We will get back to you shortly or call ${clinicPhone}.\n\nText HELP for available commands.`)
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