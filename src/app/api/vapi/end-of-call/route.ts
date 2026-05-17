import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from '@/lib/twilio'

// Vapi ended reasons that mean the patient did not speak to Pearly
const NO_ANSWER_REASONS = [
  'voicemail',
  'no-answer',
  'no_answer',
  'busy',
  'failed',
  'machine-detected',
  'machine-start-of-speech-detected',
  'customer-did-not-answer',
  'customer_did_not_answer',
]

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body    = await req.json() as Record<string, unknown>
    const message = body?.message as Record<string, unknown> | undefined

    if (message?.type !== 'end-of-call-report') {
      return NextResponse.json({ received: true })
    }

    const analysis       = message.analysis as Record<string, unknown> | undefined
    const structuredData = analysis?.structuredData as Record<string, string> | undefined
    const call           = message.call as Record<string, unknown> | undefined
    const metadata       = call?.metadata as Record<string, string> | undefined
    const clinicId       = metadata?.clinic_id || null
    const phoneObj       = call?.phoneNumber as Record<string, unknown> | undefined
    const toNumber       = phoneObj?.number as string | null || null
    const endedReason    = message.endedReason as string || 'unknown'
    const assistantId    = call?.assistantId as string || ''
    const customerPhone  = (call?.customer as Record<string, unknown>)?.number as string || ''

    const clinic  = await resolveClinic(clinicId, toNumber)
    const outcome = structuredData?.callOutcome || 'unknown'
    const summary = analysis?.summary as string || ''

    console.log(`[end-of-call] endedReason: ${endedReason} assistantId: ${assistantId} customer: ${customerPhone}`)

    // Log call to Supabase
    await supabase.from('call_logs').insert({
      clinic_id:          clinic?.id || null,
      call_id:            message.id as string || null,
      duration_seconds:   (message.durationSeconds as number) || 0,
      outcome,
      sentiment:          structuredData?.patientSentiment || 'neutral',
      confidence:         structuredData?.pearlyConfidence || 'medium',
      summary,
      success_evaluation: String(analysis?.successEvaluation || ''),
      ended_reason:       endedReason,
      cost_usd:           (message.cost as number) || 0,
      transcript:         message.transcript as string || '',
      created_at:         new Date().toISOString(),
    })

    // Alert owner on unresolved calls
    if (outcome === 'unresolved' && clinic?.owner_phone && summary) {
      await sendSMS(
        clinic.owner_phone,
        `⚠️ Pearly had trouble with a call.\n\nSummary: ${summary}\n\nCheck your dashboard for details.`
      )
    }

    // ── RECALL SMS FOLLOW-UP ─────────────────────────────────────
    // If this was a recall or reengagement call and patient did not answer
    // send the follow-up SMS now
    const isRecallCall = assistantId === process.env.VAPI_RECALL_ASSISTANT_ID ||
                         assistantId === process.env.VAPI_REENGAGEMENT_ASSISTANT_ID

    const patientDidNotAnswer = NO_ANSWER_REASONS.some(r =>
      endedReason.toLowerCase().includes(r.toLowerCase())
    )

    if (isRecallCall && patientDidNotAnswer && customerPhone && clinic) {
      console.log(`[end-of-call] Recall call not answered (${endedReason}) — sending SMS to ${customerPhone}`)

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      // Get patient's current sequence step to send the right SMS
      const { data: patient } = await supabase
        .from('patients')
        .select('patient_name, recall_sequence_step')
        .eq('clinic_id', clinic.id)
        .eq('phone', customerPhone)
        .single()

      if (patient) {
        const step = patient.recall_sequence_step ?? 0
        const isLastStep = step >= 2

        if (isLastStep) {
          await sendSMS(
            customerPhone,
            smsRecallFinal(patient.patient_name, clinic.name, clinicPhone)
          )
          console.log(`[end-of-call] Final recall SMS sent to ${patient.patient_name}`)
        } else {
          await sendSMS(
            customerPhone,
            smsRecallFollowUp(patient.patient_name, clinic.name, clinicPhone, step + 1)
          )
          console.log(`[end-of-call] Recall follow-up SMS sent to ${patient.patient_name} (step ${step + 1})`)
        }
      }
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[end-of-call] Error:', err)
    return NextResponse.json({ received: true })
  }
}