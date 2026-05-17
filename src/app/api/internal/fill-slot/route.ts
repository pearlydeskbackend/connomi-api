import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS } from '@/lib/twilio'

function parseHour(time: string): number {
  const match = time.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i)
  if (!match) return 12
  let hour = parseInt(match[1])
  const period = match[3].toUpperCase()
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return hour
}

function getTimeOfDay(time: string): 'morning' | 'afternoon' | 'evening' {
  const hour = parseHour(time)
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

function scoreCandidate(candidate: any, slot: any): number {
  let score = 100

  // Service mismatch penalty
  if (candidate.service && slot.service) {
    const slotSvc = slot.service.toLowerCase()
    const candSvc = candidate.service.toLowerCase()
    if (!slotSvc.includes(candSvc) && !candSvc.includes(slotSvc)) {
      score -= 40
    }
  }

  // Time of day preference match
  if (candidate.preferred_time_of_day) {
    const slotTOD = getTimeOfDay(slot.slot_time)
    const pref = candidate.preferred_time_of_day.toLowerCase()
    if (pref.includes('morning') && slotTOD !== 'morning') score -= 25
    if (pref.includes('afternoon') && slotTOD !== 'afternoon') score -= 25
  }

  // Also check preferred_times field
  if (candidate.preferred_times) {
    const slotTOD = getTimeOfDay(slot.slot_time)
    const pref = candidate.preferred_times.toLowerCase()
    if (pref.includes('morning') && slotTOD !== 'morning') score -= 15
    if (pref.includes('afternoon') && slotTOD !== 'afternoon') score -= 15
  }

  // Waiting longer = higher priority
  const waitDays = (Date.now() - new Date(candidate.added_at).getTime()) / (1000 * 60 * 60 * 24)
  score += Math.min(waitDays * 2, 20)

  // Explicit priority field (lower number = higher priority)
  score += (10 - (candidate.priority || 5)) * 3

  // Previous attempts = lower score
  score -= (candidate.attempt_count || 0) * 10

  return score
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-internal-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { slotId } = await req.json() as { slotId: string }

    if (!slotId) {
      return NextResponse.json({ error: 'slotId required' }, { status: 400 })
    }

    // Get the slot with clinic info
    const { data: slot } = await supabase
      .from('cancelled_slots')
      .select('*, clinics(*)')
      .eq('id', slotId)
      .eq('status', 'open')
      .single()

    if (!slot) {
      return NextResponse.json({ message: 'Slot not found or already filled' })
    }

    const clinic = slot.clinics as any

    // Check slot hasn't already passed
    const slotDate = new Date(`${slot.slot_date}T12:00:00`)
    if (slotDate < new Date()) {
      await supabase
        .from('cancelled_slots')
        .update({ status: 'expired' })
        .eq('id', slotId)
      return NextResponse.json({ message: 'Slot has passed' })
    }

    const assistantId = process.env.VAPI_WAITLIST_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

    // Get eligible waitlist candidates
    const { data: candidates } = await supabase
      .from('waitlist')
      .select('*')
      .eq('clinic_id', slot.clinic_id)
      .eq('status', 'waiting')
      .lt('attempt_count', 3)
      .gt('expires_at', new Date().toISOString())
      .order('added_at', { ascending: true })
      .limit(20)

    if (!candidates?.length) {
      console.log(`[fill-slot] No candidates for slot ${slotId}`)
      await supabase
        .from('cancelled_slots')
        .update({ fill_attempts: (slot.fill_attempts || 0) + 1 })
        .eq('id', slotId)

      // Alert owner that no one is on the waitlist
      if (clinic.owner_phone) {
        sendSMS(
          clinic.owner_phone,
          `A ${slot.service} slot opened on ${slot.slot_date} at ${slot.slot_time} but no one is on the waitlist to fill it. — Pearly Desk`
        ).catch(console.error)
      }
      return NextResponse.json({ message: 'No candidates' })
    }

    // Score and rank candidates
    const scored = candidates
      .map(c => ({ candidate: c, score: scoreCandidate(c, slot) }))
      .sort((a, b) => b.score - a.score)

    const best = scored[0].candidate
    console.log(`[fill-slot] Best match: ${best.patient_name} score=${scored[0].score} for ${slot.service} ${slot.slot_date} ${slot.slot_time}`)

    // Mark as called immediately to prevent double-calling
    await supabase
      .from('waitlist')
      .update({
        status:          'called',
        last_attempt_at: new Date().toISOString(),
        attempt_count:   (best.attempt_count || 0) + 1,
      })
      .eq('id', best.id)

    // Log the attempt
    await supabase.from('waitlist_attempts').insert({
      waitlist_id:    best.id,
      clinic_id:      slot.clinic_id,
      offered_date:   slot.slot_date,
      offered_time:   slot.slot_time,
      offered_service: slot.service,
      outcome:        'calling',
    })

    await supabase
      .from('cancelled_slots')
      .update({ fill_attempts: (slot.fill_attempts || 0) + 1 })
      .eq('id', slotId)

    // Check if slot is very soon — use SMS instead of call for faster response
    const slotDateTime = new Date(`${slot.slot_date}T12:00:00`)
    const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60)
    const isUrgent = hoursUntilSlot < 4

    if (isUrgent) {
      const smsSent = await sendSMS(
        best.phone,
        `Hi ${best.patient_name}! A ${slot.service} slot just opened at ${clinic.name} on ${slot.slot_date} at ${slot.slot_time}. Reply YES to book it or call ${clinicPhone}. Slots fill fast! — ${clinic.name}`
      )
      if (smsSent) {
        console.log(`[fill-slot] Urgent SMS sent to ${best.patient_name}`)
        return NextResponse.json({ success: true, method: 'sms', patient: best.patient_name })
      }
    } else if (assistantId && phoneNumberId) {
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
          clinicName:    clinic.name,
          clinicPhone,
        },
      })

      if (called) {
        console.log(`[fill-slot] Called ${best.patient_name}`)
        return NextResponse.json({ success: true, method: 'call', patient: best.patient_name })
      }
    }

    // Call or SMS failed — reset to waiting so retry cron can pick it up
    await supabase
      .from('waitlist')
      .update({ status: 'waiting' })
      .eq('id', best.id)

    return NextResponse.json({ success: false, message: 'Contact attempt failed — reset to waiting' })
  } catch (err) {
    console.error('[fill-slot] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}