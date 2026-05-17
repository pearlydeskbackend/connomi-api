import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { isWithinCallingHours, nextCallingWindow, MAX_CALL_ATTEMPTS } from '@/lib/schedule'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const sixMonthsAgo       = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const cutoffDate         = sixMonthsAgo.toISOString().split('T')[0]
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000).toISOString()
    const assistantId        = process.env.VAPI_RECALL_ASSISTANT_ID
    const phoneNumberId      = process.env.VAPI_PHONE_NUMBER_ID

    if (!assistantId || !phoneNumberId) {
      return NextResponse.json({ error: 'VAPI_RECALL_ASSISTANT_ID not set' }, { status: 500 })
    }

    const { data: patients } = await supabase
      .from('patients')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .lt('last_cleaning_date', cutoffDate)
      .lt('recall_attempts', MAX_CALL_ATTEMPTS)
      .or(`recall_called_at.is.null,recall_called_at.lt.${twentyFourHoursAgo}`)
      .limit(20)

    if (!patients?.length) return NextResponse.json({ success: true, called: 0 })

    let called = 0
    for (const patient of patients) {
      const clinic = patient.clinics as {
        id: string; name: string
        owner_phone: string | null
        twilio_phone: string | null
        active: boolean
      } | null
      if (!clinic?.active) continue

      const ok = await triggerVapiCall({
        assistantId,
        phoneNumberId,
        customerPhone: patient.phone,
        customerName:  patient.patient_name,
        variables: {
          patientName:      patient.patient_name,
          lastCleaningDate: patient.last_cleaning_date || 'a while ago',
          clinicName:       clinic.name,
          clinicPhone:      clinic.twilio_phone || clinic.owner_phone || '',
        },
      })

      if (ok) {
        await supabase.from('patients').update({
          recall_called_at: new Date().toISOString(),
          recall_attempts:  (patient.recall_attempts || 0) + 1,
        }).eq('id', patient.id)
        called++
      }
      await new Promise(r => setTimeout(r, 2000))
    }

    return NextResponse.json({ success: true, called, total: patients.length })
  } catch (err) {
    console.error('[recall] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}