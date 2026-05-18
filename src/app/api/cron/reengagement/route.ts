import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'
import {
  startCronLog,
  completeCronLog,
  failCronLog,
  wasContactedRecently,
  markContacted,
} from '@/lib/cron'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  const logId = await startCronLog('reengagement')

  try {
    const twelveMonthsAgo = new Date()
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12)

    const assistantId   = process.env.VAPI_REENGAGEMENT_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    if (!assistantId || !phoneNumberId) {
      await failCronLog(logId, 'VAPI_REENGAGEMENT_ASSISTANT_ID not set')
      return NextResponse.json({ error: 'VAPI_REENGAGEMENT_ASSISTANT_ID not set' }, { status: 500 })
    }

    const { data: clinics } = await supabase
      .from('clinics')
      .select('id, name, owner_phone, twilio_phone, timezone')
      .eq('active', true)

    if (!clinics?.length) {
      await completeCronLog(logId, { called: 0, skipped: 0, total: 0 })
      return NextResponse.json({ success: true, called: 0 })
    }

    let totalCalled  = 0
    let totalSkipped = 0

    for (const clinic of clinics) {
      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      // Patients who have not visited in 12+ months
      // and have never been reengaged (recall_attempts < 1)
      // and are not opted out
      const { data: patients } = await supabase
        .from('patients')
        .select('id, patient_name, phone, recall_attempts, recall_last_service, last_cleaning_date')
        .eq('clinic_id', clinic.id)
        .lt('updated_at', twelveMonthsAgo.toISOString())
        .lt('recall_attempts', 1)
        .not('recall_status', 'eq', 'opted_out')
        .is('deleted_at', null)
        .limit(5)

      if (!patients?.length) continue

      console.log(`[reengagement] ${clinic.name} — ${patients.length} patients to reengage`)

      for (const patient of patients) {
        // Rate limit — never contact same patient twice in 24 hours
        const recentlyContacted = await wasContactedRecently(clinic.id, patient.phone)
        if (recentlyContacted) {
          console.log(`[reengagement] ${patient.patient_name} — contacted recently — skipping`)
          totalSkipped++
          continue
        }

        // Get their last visit details for personalization
        const { data: lastBooking } = await supabase
          .from('bookings')
          .select('date, service')
          .eq('clinic_id', clinic.id)
          .eq('phone', patient.phone)
          .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])
          .order('date', { ascending: false })
          .limit(1)
          .single()

        const lastVisitDate    = lastBooking?.date || patient.last_cleaning_date || 'a while ago'
        const lastVisitService = lastBooking?.service || patient.recall_last_service || 'your last visit'

        // Calculate months away for context
        const monthsAway = lastBooking?.date
          ? Math.round((Date.now() - new Date(lastBooking.date).getTime()) / (1000 * 60 * 60 * 24 * 30))
          : 12

        console.log(`[reengagement] Calling ${patient.patient_name} — last seen ${monthsAway} months ago`)

        const ok = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: patient.phone,
          customerName:  patient.patient_name,
          variables: {
            patientName:    patient.patient_name,
            lastVisitDate,
            lastService:    lastVisitService,
            monthsAway:     String(monthsAway),
            callType:       'reengagement',
            clinicName:     clinic.name,
            clinicPhone,
          },
        })

        if (ok) {
          await supabase
            .from('patients')
            .update({
              recall_called_at: new Date().toISOString(),
              recall_attempts:  (patient.recall_attempts || 0) + 1,
              updated_at:       new Date().toISOString(),
            })
            .eq('id', patient.id)

          await markContacted(clinic.id, patient.phone)
          totalCalled++
          console.log(`[reengagement] Called ${patient.patient_name}`)
        }

        await new Promise(r => setTimeout(r, 3000))
      }
    }

    console.log(`[reengagement] Done — called: ${totalCalled}, skipped: ${totalSkipped}`)

    const result = { called: totalCalled, skipped: totalSkipped }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[reengagement] Error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}