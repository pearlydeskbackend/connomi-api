import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS, smsWaitlistOffer } from '@/lib/twilio'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseTimeToMinutes(time: string): number {
  const match = time.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i)
  if (!match) return 720
  let hour = parseInt(match[1])
  const min = parseInt(match[2] || '0')
  const period = match[3].toUpperCase()
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return hour * 60 + min
}

function getSlotDateTime(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const totalMins  = parseTimeToMinutes(timeStr)
  const hour       = Math.floor(totalMins / 60)
  const min        = totalMins % 60
  return new Date(y, m - 1, d, hour, min, 0)
}

function getTimeOfDay(time: string): 'morning' | 'afternoon' | 'evening' {
  const mins = parseTimeToMinutes(time)
  if (mins < 720)  return 'morning'
  if (mins < 1020) return 'afternoon'
  return 'evening'
}

function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

function scoreCandidate(candidate: any, slot: any): number {
  let score = 100

  // Service match
  if (candidate.service && slot.service) {
    const slotSvc = slot.service.toLowerCase()
    const candSvc = candidate.service.toLowerCase()
    if (!slotSvc.includes(candSvc) && !candSvc.includes(slotSvc)) {
      score -= 40
    }
  }

  // Time of day preference
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

  // Day of week preference
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

  // Wait time bonus
  const waitDays = (Date.now() - new Date(candidate.added_at).getTime()) / (1000 * 60 * 60 * 24)
  score += Math.min(waitDays * 2, 20)

  // Priority field
  score += (10 - (candidate.priority || 5)) * 3

  // Attempt penalty
  score -= (candidate.attempt_count || 0) * 10

  // Decline penalty
  score -= (candidate.declined_count || 0) * 15

  return Math.max(score, 0)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-internal-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let slotId: string | null = null

  try {
    const body = await req.json() as { slotId: string }
    slotId = body.slotId
    if (!slotId) return NextResponse.json({ error: 'slotId required' }, { status: 400 })

    console.log(`[fill-slot] Processing slot ${slotId}`)

    // ── STEP 1: ATOMIC CLAIM ──────────────────────────────────────
    // Update and select separately — Supabase does not support
    // .select('*, clinics(*)') on .update() reliably
    const { data: claimed, error: claimError } = await supabase
      .from('cancelled_slots')
      .update({
        status:        'processing',
        processing_at: new Date().toISOString(),
      })
      .eq('id', slotId)
      .eq('status', 'open')
      .select('id, status')
      .maybeSingle()

    console.log('[fill-slot] Claim result:', JSON.stringify(claimed), 'error:', claimError?.message)

    if (claimError || !claimed) {
      console.log(`[fill-slot] Slot ${slotId} not available — already processing or filled`)
      return NextResponse.json({ message: 'Slot not available' })
    }

    console.log(`[fill-slot] Slot ${slotId} claimed successfully`)

    // ── STEP 2: FETCH FULL SLOT WITH CLINIC ───────────────────────
    const { data: slot, error: slotError } = await supabase
      .from('cancelled_slots')
      .select('*, clinics(*)')
      .eq('id', slotId)
      .single()

    if (slotError || !slot) {
      console.error('[fill-slot] Could not fetch slot after claim')
      await supabase
        .from('cancelled_slots')
        .update({ status: 'open', processing_at: null })
        .eq('id', slotId)
      return NextResponse.json({ message: 'Slot not found' })
    }

    const clinic      = slot.clinics as any
    const clinicPhone = clinic?.twilio_phone || clinic?.owner_phone || ''
    const now         = new Date().toISOString()

    // ── STEP 3: EXPIRY CHECK ──────────────────────────────────────
    const slotDateTime   = getSlotDateTime(String(slot.slot_date), slot.slot_time)
    const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60)

    if (hoursUntilSlot <= 0) {
      await supabase
        .from('cancelled_slots')
        .update({ status: 'expired' })
        .eq('id', slotId)
      console.log(`[fill-slot] Slot ${slotId} has already passed`)
      return NextResponse.json({ message: 'Slot has passed' })
    }

    const isUrgent = hoursUntilSlot < 4
    console.log(`[fill-slot] ${hoursUntilSlot.toFixed(1)}h until slot — urgent: ${isUrgent}`)

    // ── STEP 4: GET ELIGIBLE CANDIDATES ──────────────────────────
    const { data: candidates } = await supabase
      .from('waitlist')
      .select('*')
      .eq('clinic_id', slot.clinic_id)
      .eq('status', 'waiting')
      .lt('attempt_count', 3)
      .is('deleted_at', null)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('priority', { ascending: true })
      .order('added_at', { ascending: true })
      .limit(20)

    if (!candidates?.length) {
      await supabase
        .from('cancelled_slots')
        .update({
          status:        'open',
          processing_at: null,
          fill_attempts: (slot.fill_attempts || 0) + 1,
        })
        .eq('id', slotId)

      if (clinic?.owner_phone) {
        sendSMS(
          clinic.owner_phone,
          `A ${slot.service} slot opened on ${slot.slot_date} at ${slot.slot_time} but no one is on the waitlist. — Pearly Desk`
        ).catch(console.error)
      }

      console.log(`[fill-slot] No candidates for slot ${slotId}`)
      return NextResponse.json({ message: 'No candidates — slot released' })
    }

    // ── STEP 5: CONFLICT CHECK ────────────────────────────────────
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
          .maybeSingle()
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
      console.log(`[fill-slot] All candidates have conflicts`)
      return NextResponse.json({ message: 'All candidates have conflicts' })
    }

    // ── STEP 6: SCORE AND RANK ────────────────────────────────────
    const scored = eligible
      .map(c => ({ candidate: c, score: scoreCandidate(c, slot) }))
      .sort((a, b) => b.score - a.score)

    console.log(`[fill-slot] ${scored.length} eligible candidates`)
    scored.slice(0, 3).forEach((s, i) => {
      console.log(`[fill-slot] #${i + 1} ${s.candidate.patient_name} score=${s.score}`)
    })

    // ── STEP 7: BUILD QUEUE ───────────────────────────────────────
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

    // ── STEP 8: RELEASE SLOT BACK TO OPEN ────────────────────────
    // Must happen before contacting patient so they can book
    await supabase
      .from('cancelled_slots')
      .update({
        status:           'open',
        processing_at:    null,
        fill_attempts:    (slot.fill_attempts || 0) + 1,
        first_contact_at: now,
        candidates_tried: scored.length,
      })
      .eq('id', slotId)

    // ── STEP 9: MARK #1 CANDIDATE AS CALLED ──────────────────────
    const best = scored[0].candidate
    const job1 = insertedJobs?.[0]

    await supabase
      .from('waitlist')
      .update({
        status:          'called',
        last_attempt_at: now,
        attempt_count:   (best.attempt_count || 0) + 1,
      })
      .eq('id', best.id)
      .eq('status', 'waiting')

    await supabase.from('waitlist_attempts').insert({
      waitlist_id:     best.id,
      clinic_id:       slot.clinic_id,
      offered_date:    slot.slot_date,
      offered_time:    slot.slot_time,
      offered_service: slot.service,
      outcome:         'calling',
    })

    // ── STEP 10: CONTACT CANDIDATE #1 ────────────────────────────
    let contactMethod = 'none'
    const assistantId   = process.env.VAPI_WAITLIST_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    if (isUrgent) {
      const smsSent = await sendSMS(
        best.phone,
        smsWaitlistOffer(
          best.patient_name, slot.service,
          String(slot.slot_date), slot.slot_time,
          clinic?.name || '', clinicPhone
        )
      )

      if (smsSent) {
        contactMethod = 'sms'
        // Reset to waiting so YES reply can book
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
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', best.id)
      }

    } else if (assistantId && phoneNumberId) {
      const called = await triggerVapiCall({
        assistantId,
        phoneNumberId,
        customerPhone: best.phone,
        customerName:  best.patient_name,
        variables: {
          patientName:   best.patient_name,
          availableDate: String(slot.slot_date),
          availableTime: slot.slot_time,
          service:       slot.service,
          slotId:        slotId!,
          clinicName:    clinic?.name || '',
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
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', best.id)
      }
    }

    console.log(`[fill-slot] Done — ${best.patient_name} via ${contactMethod} — ${scored.length - 1} in queue`)

    return NextResponse.json({
      success:        true,
      method:         contactMethod,
      patient:        best.patient_name,
      score:          scored[0].score,
      queued:         scored.length - 1,
      urgent:         isUrgent,
      hoursUntilSlot: Math.round(hoursUntilSlot * 10) / 10,
    })

  } catch (err) {
    console.error('[fill-slot] Unhandled error:', err)
    if (slotId) {
      void supabase
        .from('cancelled_slots')
        .update({ status: 'open', processing_at: null })
        .eq('id', slotId)
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}