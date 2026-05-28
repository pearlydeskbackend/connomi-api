import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from '@/lib/twilio'

const NO_ANSWER_REASONS = [
  'voicemail','no-answer','no_answer','busy','failed',
  'machine-detected','machine-start-of-speech-detected',
  'customer-did-not-answer','customer_did_not_answer',
]

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body    = await req.json() as Record<string, unknown>
    const message = body?.message as Record<string, unknown> | undefined

    if (!message) return NextResponse.json({ received: true })

    const messageType = message.type as string

    // ── HANDLE STATUS-UPDATE (call started / ended) ────────────────────
    // Vapi sends this when a call begins (status: in-progress) or ends
    if (messageType === 'status-update') {
      const status = message.status as string
      const call   = message.call as Record<string, unknown> | undefined
      if (!call) return NextResponse.json({ received: true })

      const callId        = call.id as string
      const phoneObj      = call.phoneNumber as Record<string, unknown> | undefined
      const toNumber      = phoneObj?.number as string | null ?? null
      const customerPhone = (call.customer as Record<string, unknown>)?.number as string ?? ''
      const metadata      = call.metadata as Record<string, string> | undefined
      const clinicId      = metadata?.clinic_id ?? null

      let resolvedClinicId = clinicId
      if (!resolvedClinicId && toNumber) {
        const { data } = await supabase
          .from('clinics').select('id').eq('twilio_phone', toNumber).single()
        resolvedClinicId = data?.id ?? null
      }

      if (!resolvedClinicId) return NextResponse.json({ received: true })

      if (status === 'in-progress') {
        // Upsert active call — dashboard realtime picks this up → triggers mood state
        await supabase.from('active_calls').upsert({
          call_id:    callId,
          clinic_id:  resolvedClinicId,
          phone:      customerPhone || null,
          started_at: new Date().toISOString(),
          status:     'active',
        }, { onConflict: 'call_id' })
        console.log(`[status-update] Call started: ${callId}`)
      }

      if (status === 'ended') {
        await supabase.from('active_calls')
          .update({ status: 'ended', ended_at: new Date().toISOString() })
          .eq('call_id', callId)
        console.log(`[status-update] Call ended: ${callId}`)
      }

      return NextResponse.json({ received: true })
    }

    // ── HANDLE END-OF-CALL-REPORT ──────────────────────────────────────
    if (messageType !== 'end-of-call-report') {
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
    const callId         = (message.id ?? call?.id) as string | null || null
    const direction      = (call?.type as string) === 'outboundPhoneCall' ? 'outbound' : 'inbound'

    const clinic  = await resolveClinic(clinicId, toNumber)
    const outcome = structuredData?.callOutcome || 'unknown'
    const summary = analysis?.summary as string || ''

    // Look up patient name from phone
    let patientName: string | null = null
    if (customerPhone && clinic?.id) {
      const { data: patient } = await supabase
        .from('patients').select('patient_name')
        .eq('clinic_id', clinic.id).eq('phone', customerPhone).maybeSingle()
      patientName = patient?.patient_name ?? null
    }

    console.log(`[end-of-call] endedReason: ${endedReason} customer: ${customerPhone} callId: ${callId}`)

    // ── DUPLICATE PREVENTION ──────────────────────────────────────────
    if (callId) {
      const { data: existing } = await supabase
        .from('call_logs').select('id').eq('call_id', callId).maybeSingle()
      if (existing) {
        console.log(`[end-of-call] Duplicate webhook for call ${callId} — skipping`)
        return NextResponse.json({ received: true, duplicate: true })
      }
    }

    // ── LOG CALL ──────────────────────────────────────────────────────
    const baseLog = {
      clinic_id:          clinic?.id || null,
      call_id:            callId,
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
    }

    const { error: logError } = await supabase.from('call_logs').insert({
      ...baseLog,
      phone:        customerPhone || null,
      patient_name: patientName,
      direction,
    })

    if (logError) {
      console.warn('[end-of-call] Full insert failed, trying base fields:', logError.message)
      await supabase.from('call_logs').insert(baseLog)
    }

    // ── ALERT OWNER ON UNRESOLVED CALLS ───────────────────────────────
    if (outcome === 'unresolved' && clinic?.owner_phone && summary) {
      sendSMS(
        clinic.owner_phone,
        `⚠️ Pearly had trouble with a call.\n\nSummary: ${summary}\n\nCheck your dashboard for details.`
      ).catch(err => console.error('[end-of-call] Owner SMS error:', err))
    }

    // ── RECALL SMS ────────────────────────────────────────────────────
    const isRecallCall =
      assistantId === process.env.VAPI_RECALL_ASSISTANT_ID ||
      assistantId === process.env.VAPI_REENGAGEMENT_ASSISTANT_ID

    const patientDidNotAnswer = NO_ANSWER_REASONS.some(r =>
      endedReason.toLowerCase().includes(r.toLowerCase())
    )

    if (isRecallCall && patientDidNotAnswer && customerPhone && clinic) {
      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
      const { data: patient } = await supabase
        .from('patients').select('patient_name, recall_sequence_step')
        .eq('clinic_id', clinic.id).eq('phone', customerPhone).maybeSingle()

      if (patient) {
        const step       = patient.recall_sequence_step ?? 0
        const isLastStep = step >= 2
        const smsSent = await sendSMS(
          customerPhone,
          isLastStep
            ? smsRecallFinal(patient.patient_name, clinic.name, clinicPhone)
            : smsRecallFollowUp(patient.patient_name, clinic.name, clinicPhone, step + 1)
        )
        if (smsSent) {
          await supabase.from('patients')
            .update({ recall_sms_sent_at: new Date().toISOString() })
            .eq('clinic_id', clinic.id).eq('phone', customerPhone)
        }
      }
    }

    return NextResponse.json({ received: true })

  } catch (err) {
    console.error('[end-of-call] Error:', err)
    return NextResponse.json({ received: true })
  }
}