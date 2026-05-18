import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS, smsWaitlistOffer } from '@/lib/twilio'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseTimeToMinutes(time: string): number {
  const match = time.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i)
  if (!match) return 720 // default noon
  let hour = parseInt(match[1])
  const min = parseInt(match[2] || '0')
  const period = match[3].toUpperCase()
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return hour * 60 + min
}

function getSlotDateTime(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const totalMins = parseTimeToMinutes(timeStr)
  const hour = Math.floor(totalMins / 60)
  const min  = totalMins % 60
  return new Date(y, m - 1, d, hour, min, 0)
}

function getTimeOfDay(time: string): 'morning' | 'afternoon' | 'evening' {
  const mins = parseTimeToMinutes(time)
  if (mins < 720) return 'morning'   // before noon
  if (mins < 1020) return 'afternoon' // before 5pm
  return 'evening'
}

function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

function scoreCandidate(candidate: any, slot: any): number {
  let score = 100

  // ── Service match ──────────────────────────────────────────────
  if (candidate.service && slot.service) {
    const slotSvc = slot.service.toLowerCase()
    const candSvc = candidate.service.toLowerCase()
    if (!slotSvc.includes(candSvc) && !candSvc.includes(slotSvc)) {
      score -= 40
    }
  }

  // ── Time of day preference ────────────────────────────────────
  const slotTOD = getTimeOfDay(slot.slot_time)
  if (candidate.preferred_time_of_day) {
    if (!candidate.preferred_time_of_day.toLowerCase().includes(slotTOD)) {
      score -= 25
    }
  }
  if (candidate.preferred_times) {
    const pref = candidate.preferred_times.toLowerCase()
    if (pref.includes('morning') && slotTOD !== 'morning') score -= 15
    if (pref.includes('afternoon') && slotTOD !== 'afternoon') score -= 15
  }

  // ── Day of week preference ────────────────────────────────────
  const slotDay = getDayOfWeek(slot.slot_date)
  if (candidate.preferred_day_numbers) {
    const preferredDays = candidate.preferred_day_numbers
      .split(',')
      .map((n: string) => parseInt(n.trim()))
      .filter((n: number) => !isNaN(n))
    if (preferredDays.length > 0 && !preferredDays.includes(slotDay)) {
      score -= 20
    }
  }
  if (candidate.preferred_days) {
    const lower    = candidate.preferred_days.toLowerCase()
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
    if (!lower.includes(dayNames[slotDay])) score -= 10
  }

  // ── Wait time bonus ───────────────────────────────────────────
  const waitDays = (Date.now() - new Date(candidate.added_at).getTime()) / (1000 * 60 * 60 * 24)
  score += Math.min(waitDays * 2, 20)

  // ── Priority field ────────────────────────────────────────────
  score += (10 - (candidate.priority || 5)) * 3

  // ── Attempt penalty ───────────────────────────────────────────
  score -= (candidate.attempt_count || 0) * 10

  // ── Decline penalty ───────────────────────────────────────────
  score -= (candidate.declined_count || 0) * 15

  return Math.max(score, 0)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-internal-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { slotId } = await req.json() as { slotId: string }
    if (!slotId) return NextResponse.json({ error: 'slotId required' }, { status: 400 })

    // ── ATOMIC CLAIM ──────────────────────────────────────────────
    // Only one process can claim a slot at a time
    // If status is not 'open' this returns null — exit immediately
    const { data: slot } = await supabase
      .from('cancelled_slots')
      .update({ status: 'processing', processing_at: new Date().toISOString() })
      .eq('id', slotId)
      .eq('status', 'open')
      .select('*, clinics(*)')
      .single()

    if (!slot) {
      console.log(`[fill-slot] Slot ${slotId} not available — already processing or filled`)
      return NextResponse.json({ message: 'Slot not available' })
    }

    const clinic      = slot.clinics as any
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    const now         = new Date().toISOString()

    // ── SLOT EXPIRY CHECK ─────────────────────────────────────────
    const slotDateTime   = getSlotDateTime(slot.slot_date, slot.slot_time)
    const msUntilSlot    = slotDateTime.getTime() - Date.now()
    const hoursUntilSlot = msUntilSlot / (1000 * 60 * 60)

    if (hoursUntilSlot <= 0) {
      await supabase
        .from('cancelled_slots')
        .update({ status: 'expired' })
        .eq('id', slotId)
      console.log(`[fill-slot] Slot ${slotId} has already passed`)
      return NextResponse.json({ message: 'Slot has passed' })
    }

    const isUrgent = hoursUntilSlot < 4

    // ── GET ELIGIBLE CANDIDATES ───────────────────────────────────
    const { data: candidates } = await supabase
      .from('waitlist')
      .select('*')
      .eq('clinic_id', slot.clinic_id)
      .eq('status', 'waiting')
      .lt('attempt_count', 3)
      .is('deleted_at', null)
      // Handle null expires_at gracefully — treat as never expiring
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('priority', { ascending: true })
      .order('added_at', { ascending: true })
      .limit(20)

    if (!candidates?.length) {
      // No candidates — release slot and alert owner
      await supabase
        .from('cancelled_slots')
        .update({
          status:        'open',
          processing_at: null,
          fill_attempts: (slot.fill_attempts || 0) + 1,
        })
        .eq('id', slotId)

      if (clinic.owner_phone) {
        sendSMS(
          clinic.owner_phone,
          `A ${slot.service} slot opened on ${slot.slot_date} at ${slot.slot_time} but no one is on the waitlist to fill it. — Pearly Desk`
        ).catch(console.error)
      }

      console.log(`[fill-slot] No candidates for slot ${slotId}`)
      return NextResponse.json({ message: 'No candidates — slot released' })
    }

    // ── FILTER OUT CONFLICT CANDIDATES ────────────────────────────
    // Do not call patients who already have a booking at this time
    const conflictChecks = await Promise.all(
      candidates.map(async (c) => {
        const { data: conflict } = await supabase
          .from('bookings')
          .select('id')
          .eq('clinic_id', slot.clinic_id)
          .eq('phone', c.phone)
          .eq('date', slot.slot_date)
          .eq('time', slot.slot_time)
          .in('status', ['Confirmed', 'Patient Confirmed'])
          .limit(1)
          .single()
        return { candidate: c, hasConflict: !!conflict }
      })
    )

    const eligible = conflictChecks
      .filter(r => !r.hasConflict)
      .map(r => r.candidate)

    if (!eligible.length) {
      await supabase
        .from('cancelled_slots')
        .update({ status: 'open', processing_at: null })
        .eq('id', slotId)
      return NextResponse.json({ message: 'All candidates have conflicts' })
    }

    // ── SCORE AND RANK ────────────────────────────────────────────
    const scored = eligible
      .map(c => ({ candidate: c, score: scoreCandidate(c, slot) }))
      .sort((a, b) => b.score - a.score)

    console.log(`[fill-slot] ${scored.length} eligible candidates for ${slot.service} ${slot.slot_date} ${slot.slot_time}`)
    scored.slice(0, 3).forEach((s, i) => {
      console.log(`[fill-slot] #${i + 1} ${s.candidate.patient_name} score=${s.score}`)
    })

    // ── BUILD QUEUE FOR TOP 5 CANDIDATES ─────────────────────────
    const queueJobs = scored.slice(0, 5).map((s, index) => ({
      clinic_id:      slot.clinic_id,
      slot_id:        slotId,
      waitlist_id:    s.candidate.id,
      patient_name:   s.candidate.patient_name,
      phone:          s.candidate.phone,
      service:        slot.service,
      slot_date:      slot.slot_date,
      slot_time:      slot.slot_time,
      priority_score: s.score,
      queue_position: index + 1,
      status:         index === 0 ? 'calling' : 'pending',
      method:         isUrgent ? 'sms' : 'call',
      scheduled_at:   new Date(Date.now() + index * 10 * 60 * 1000).toISOString(),
    }))

    const { data: insertedJobs, error: queueError } = await supabase
      .from('waitlist_call_queue')
      .insert(queueJobs)
      .select()

    if (queueError) {
      console.error('[fill-slot] Queue error:', queueError.message)
      await supabase
        .from('cancelled_slots')
        .update({ status: 'open', processing_at: null })
        .eq('id', slotId)
      return NextResponse.json({ error: 'Queue failed' }, { status: 500 })
    }

    // ── CONTACT CANDIDATE #1 IMMEDIATELY ─────────────────────────
    const best    = scored[0].candidate
    const job1    = insertedJobs?.[0]

    // Mark waitlist entry as called
    await supabase
      .from('waitlist')
      .update({
        status:          'called',
        last_attempt_at: now,
        attempt_count:   (best.attempt_count || 0) + 1,
      })
      .eq('id', best.id)
      .eq('status', 'waiting')

    // Log the attempt
    await supabase.from('waitlist_attempts').insert({
      waitlist_id:     best.id,
      clinic_id:       slot.clinic_id,
      offered_date:    slot.slot_date,
      offered_time:    slot.slot_time,
      offered_service: slot.service,
      outcome:         'calling',
    })

    // Update slot tracking
    await supabase
      .from('cancelled_slots')
      .update({
        status:           'open', // back to open so cascade can find it
        processing_at:    null,
        fill_attempts:    (slot.fill_attempts || 0) + 1,
        first_contact_at: now,
        candidates_tried: scored.length,
      })
      .eq('id', slotId)

    let contactMethod = 'none'

    const assistantId   = process.env.VAPI_WAITLIST_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    if (isUrgent) {
      // Urgent — SMS is faster than a call
      const smsSent = await sendSMS(
        best.phone,
        smsWaitlistOffer(
          best.patient_name, slot.service,
          slot.slot_date, slot.slot_time,
          clinic.name, clinicPhone
        )
      )

      if (smsSent) {
        contactMethod = 'sms'
        // Reset waitlist status to waiting so YES reply can book
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', best.id)

        if (job1) {
          await supabase
            .from('waitlist_call_queue')
            .update({ status: 'called', outcome: 'sms_sent' })
            .eq('id', job1.id)
        }
      } else {
        // SMS failed — reset for cascade to retry
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', best.id)
      }

    } else if (assistantId && phoneNumberId) {
      // Standard — Pearly calls
      const called = await triggerVapiCall({
        assistantId,
        phoneNumberId,
        customerPhone: best.phone,
        customerName:  best.patient_name,
        variables: {
          patientName:   best.patient_name,
          availableDate: slot.slot_date,
          availableTime: slot.slot_time,
          service:       slot.service,
          slotId:        slotId,
          clinicName:    clinic.name,
          clinicPhone,
        },
      })

      if (called) {
        contactMethod = 'call'
        if (job1) {
          await supabase
            .from('waitlist_call_queue')
            .update({ status: 'called', outcome: 'call_initiated' })
            .eq('id', job1.id)
        }
      } else {
        // Call failed — reset for cascade
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', best.id)
      }
    }

    console.log(`[fill-slot] Contacted ${best.patient_name} via ${contactMethod} — ${scored.length - 1} candidates queued as backup`)

    return NextResponse.json({
      success:       true,
      method:        contactMethod,
      patient:       best.patient_name,
      score:         scored[0].score,
      queued:        scored.length - 1,
      urgent:        isUrgent,
      hoursUntilSlot: Math.round(hoursUntilSlot * 10) / 10,
    })

  } catch (err) {
    console.error('[fill-slot] Error:', err)
    // Always release the slot on error
    try {
      const { slotId } = await req.json().catch(() => ({ slotId: null })) as any
      if (slotId) {
        await supabase
          .from('cancelled_slots')
          .update({ status: 'open', processing_at: null })
          .eq('id', slotId)
      }
    } catch {}
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}