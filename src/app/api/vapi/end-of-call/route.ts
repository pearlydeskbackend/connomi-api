import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS } from '@/lib/twilio'

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

    const clinic  = await resolveClinic(clinicId, toNumber)
    const outcome = structuredData?.callOutcome || 'unknown'
    const summary = analysis?.summary as string || ''

    await supabase.from('call_logs').insert({
      clinic_id:          clinic?.id || null,
      call_id:            message.id as string || null,
      duration_seconds:   (message.durationSeconds as number) || 0,
      outcome,
      sentiment:          structuredData?.patientSentiment || 'neutral',
      confidence:         structuredData?.pearlyConfidence || 'medium',
      summary,
      success_evaluation: String(analysis?.successEvaluation || ''),
      ended_reason:       message.endedReason as string || 'unknown',
      cost_usd:           (message.cost as number) || 0,
      transcript:         message.transcript as string || '',
      created_at:         new Date().toISOString(),
    })

    if (outcome === 'unresolved' && clinic?.owner_phone && summary) {
      await sendSMS(clinic.owner_phone, `⚠️ Pearly had trouble with a call.\n\nSummary: ${summary}\n\nCheck your dashboard for details.`)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[end-of-call] Error:', err)
    return NextResponse.json({ received: true })
  }
}