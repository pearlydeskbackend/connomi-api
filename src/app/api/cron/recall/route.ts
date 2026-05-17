import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

// Sequence configuration — easy to adjust per clinic in future
const SEQUENCE = [
  // Step 0 — First attempt: call only
  {
    step:           0,
    action:         'call' as const,
    daysUntilNext:  3,
    sendSms:        true,
    smsIsFollowUp:  true,
  },
  // Step 1 — Second attempt: call + SMS
  {
    step:           1,
    action:         'call' as const,
    daysUntilNext:  5,
    sendSms:        true,
    smsIsFollowUp:  true,
  },
  // Step 2 — Final: SMS only, no more calls
  {
    step:           2,
    action:         'sms' as const,
    daysUntilNext:  null, // exhausted after this
    sendSms:        true,
    smsIsFollowUp:  false,
  },
]

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const now            = new Date().toISOString()
    const sixMonthsAgo   = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const cutoffDate     = sixMonthsAgo.toISOString().split('T')[0]
    const assistantId    = process.env.VAPI_RECALL_ASSISTANT_ID
    const phoneNumberId  = process.env.VAPI_PHONE_NUMBER_ID

    if (!assistantId || !phoneNumberId) {
      return NextResponse.json({ error: 'VAPI_RECALL_ASSISTANT_ID not set' }, { status: 500 })
    }

    // Fetch patients ready for their next recall attempt
    // Includes both 'pending' (never contacted) and 'in_progress' (in sequence)
    const { data: patients, error } = await supabase
      .from('patients')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .lt('last_cleaning_date', cutoffDate)
      .in('recall_status', ['pending', 'in_progress'])
      .or(`recall_next_attempt_at.is.null,recall_next_attempt_at.lte.${now}`)
      .order('recall_next_attempt_at', { ascending: true, nullsFirst: true })
      .limit(15) // Conservative limit — each call takes time

    if (error) {
      console.error('[recall] Query error:', error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!patients?.length) {
      console.log('[recall] No patients due for recall')
      return NextResponse.json({ success: true, called: 0, smsOnly: 0 })
    }

    console.log(`[recall] ${patients.length} patients due for recall`)

    let called   = 0
    let smsOnly  = 0
    let skipped  = 0

    for (const patient of patients) {
      const clinic = patient.clinics as {
        id: string
        name: string
        owner_phone: string | null
        twilio_phone: string | null
        active: boolean
      } | null

      if (!clinic?.active) {
        skipped++
        continue
      }

      const clinicPhone  = clinic.twilio_phone || clinic.owner_phone || ''
      const currentStep  = patient.recall_sequence_step ?? 0
      const sequence     = SEQUENCE[currentStep]

      if (!sequence) {
        // Past end of sequence — mark exhausted
        await supabase
          .from('patients')
          .update({ recall_status: 'exhausted', updated_at: now })
          .eq('id', patient.id)
        continue
      }

      console.log(`[recall] ${patient.patient_name} — step ${currentStep} — action: ${sequence.action}`)

      let actionSucceeded = false

      // Execute the action for this sequence step
      if (sequence.action === 'call') {
        actionSucceeded = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: patient.phone,
          customerName:  patient.patient_name,
          variables: {
            patientName:      patient.patient_name,
            lastCleaningDate: patient.last_cleaning_date || 'a while ago',
            lastService:      patient.recall_last_service || 'cleaning',
            attemptNumber:    String(currentStep + 1),
            clinicName:       clinic.name,
            clinicPhone,
          },
        })

        if (actionSucceeded) called++

      } else if (sequence.action === 'sms') {
        // Final step — SMS only
        actionSucceeded = await sendSMS(
          patient.phone,
          smsRecallFinal(patient.patient_name, clinic.name, clinicPhone)
        )
        if (actionSucceeded) smsOnly++
      }

      // Send follow-up SMS if configured for this step (after a call attempt)
      if (sequence.sendSms && sequence.smsIsFollowUp && sequence.action === 'call') {
        await sendSMS(
          patient.phone,
          smsRecallFollowUp(patient.patient_name, clinic.name, clinicPhone, currentStep + 1)
        ).catch(err => console.error('[recall] SMS error:', err))
      }

      // Advance the sequence
      if (actionSucceeded || sequence.action === 'sms') {
        const nextStep       = currentStep + 1
        const nextSequence   = SEQUENCE[nextStep]
        const isExhausted    = !nextSequence

        await supabase
          .from('patients')
          .update({
            recall_status:          isExhausted ? 'exhausted' : 'in_progress',
            recall_sequence_step:   nextStep,
            recall_called_at:       now,
            recall_attempts:        (patient.recall_attempts || 0) + 1,
            recall_next_attempt_at: isExhausted
              ? null
              : daysFromNow(sequence.daysUntilNext!),
            recall_sms_sent_at:     sequence.sendSms ? now : patient.recall_sms_sent_at,
            updated_at:             now,
          })
          .eq('id', patient.id)

        console.log(`[recall] ${patient.patient_name} — advanced to step ${nextStep}${isExhausted ? ' (exhausted)' : ` — next attempt in ${sequence.daysUntilNext} days`}`)
      }

      // Respectful delay between calls
      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`[recall] Done — called: ${called}, smsOnly: ${smsOnly}, skipped: ${skipped}`)

    return NextResponse.json({
      success: true,
      called,
      smsOnly,
      skipped,
      total: patients.length,
    })

  } catch (err) {
    console.error('[recall] Unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}