import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from '@/lib/twilio'

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
    // Use original body parsing — this is what worked before
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

    // ── RECALL SMS ───────────────────────────────────────────────
    const isRecallCall =
      assistantId === process.env.VAPI_RECALL_ASSISTANT_ID ||
      assistantId === process.env.VAPI_REENGAGEMENT_ASSISTANT_ID

    const patientDidNotAnswer = NO_ANSWER_REASONS.some(r =>
      endedReason.toLowerCase().includes(r.toLowerCase())
    )

    console.log(`[end-of-call] isRecallCall: ${isRecallCall} patientDidNotAnswer: ${patientDidNotAnswer}`)

    if (isRecallCall && patientDidNotAnswer && customerPhone && clinic) {
      console.log(`[end-of-call] Sending recall SMS to ${customerPhone}`)

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      const { data: patient } = await supabase
        .from('patients')
        .select('patient_name, recall_sequence_step')
        .eq('clinic_id', clinic.id)
        .eq('phone', customerPhone)
        .single()

      if (patient) {
        const step       = patient.recall_sequence_step ?? 0
        const isLastStep = step >= 2

        const smsSent = await sendSMS(
          customerPhone,
          isLastStep
            ? smsRecallFinal(patient.patient_name, clinic.name, clinicPhone)
            : smsRecallFollowUp(patient.patient_name, clinic.name, clinicPhone, step + 1)
        )

        console.log(`[end-of-call] Recall SMS sent: ${smsSent} to ${patient.patient_name} step ${step}`)

        if (smsSent) {
          await supabase
            .from('patients')
            .update({ recall_sms_sent_at: new Date().toISOString() })
            .eq('clinic_id', clinic.id)
            .eq('phone', customerPhone)
        }
      } else {
        console.log(`[end-of-call] No patient record found for ${customerPhone}`)
      }
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[end-of-call] Error:', err)
    return NextResponse.json({ received: true })
  }
}