import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const twelveMonthsAgo = new Date()
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12)
    const assistantId   = process.env.VAPI_REENGAGEMENT_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    if (!assistantId || !phoneNumberId) {
      return NextResponse.json({ error: 'VAPI_REENGAGEMENT_ASSISTANT_ID not set' }, { status: 500 })
    }

    const { data: clinics } = await supabase
      .from('clinics').select('id, name, owner_phone, twilio_phone').eq('active', true)

    if (!clinics?.length) return NextResponse.json({ success: true, called: 0 })

    let totalCalled = 0

    for (const clinic of clinics) {
      const { data: patients } = await supabase
        .from('patients').select('id, patient_name, phone, recall_attempts')
        .eq('clinic_id', clinic.id)
        .lt('updated_at', twelveMonthsAgo.toISOString())
        .lt('recall_attempts', 1)
        .limit(5)

      if (!patients?.length) continue

      for (const patient of patients) {
        const { data: lastBooking } = await supabase
          .from('bookings').select('date')
          .eq('clinic_id', clinic.id).eq('phone', patient.phone)
          .in('status', ['Confirmed', 'Checked In'])
          .order('date', { ascending: false }).limit(1).single()

        const ok = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: patient.phone,
          customerName:  patient.patient_name,
          variables: {
            patientName:   patient.patient_name,
            lastVisitDate: lastBooking?.date || 'a while ago',
            clinicName:    clinic.name,
            clinicPhone:   clinic.twilio_phone || clinic.owner_phone || '',
          },
        })

        if (ok) {
          await supabase.from('patients').update({
            recall_called_at: new Date().toISOString(),
            recall_attempts:  (patient.recall_attempts || 0) + 1,
          }).eq('id', patient.id)
          totalCalled++
        }
        await new Promise(r => setTimeout(r, 3000))
      }
    }

    return NextResponse.json({ success: true, called: totalCalled })
  } catch (err) {
    console.error('[reengagement] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}