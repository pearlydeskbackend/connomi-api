import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS } from '@/lib/twilio'
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

  const logId = await startCronLog('noshow')

  try {
    const now          = new Date().toISOString()
    const yesterday    = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    console.log(`[noshow] Checking for no-shows on ${yesterdayStr}`)

    // Only flag status: Confirmed as no-shows
    // Patient Confirmed means they replied to SMS — likely showed up
    // and staff just did not update the status
    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .eq('date', yesterdayStr)
      .eq('status', 'Confirmed') // intentionally NOT 'Patient Confirmed'
      .is('no_show_at', null)
      .is('cancelled_at', null)
      .is('reappointment_sent_at', null) // skip if reappointment already called
      .is('deleted_at', null)

    if (error) {
      console.error('[noshow] Query error:', error.message)
      await failCronLog(logId, error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log('[noshow] No no-shows detected')
      await completeCronLog(logId, { processed: 0, skipped: 0, total: 0 })
      return NextResponse.json({ success: true, processed: 0 })
    }

    console.log(`[noshow] ${appointments.length} potential no-shows detected`)

    let processed = 0
    let skipped   = 0

    const assistantId   = process.env.VAPI_RECALL_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    for (const appt of appointments) {
      const clinic = appt.clinics as {
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

      // Rate limit — never contact same patient twice in 24 hours
      // Prevents overlap with reappointment cron
      const recentlyContacted = await wasContactedRecently(clinic.id, appt.phone)
      if (recentlyContacted) {
        console.log(`[noshow] ${appt.patient_name} — contacted recently — skipping`)
        skipped++
        continue
      }

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      console.log(`[noshow] ${appt.patient_name} — ${appt.service} — marking as no-show`)

      // Mark as no-show first — prevents double processing
      await supabase
        .from('bookings')
        .update({
          no_show_at: now,
          updated_at: now,
        })
        .eq('id', appt.id)

      // Call the patient to check in and offer rebook
      if (assistantId && phoneNumberId) {
        const ok = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: appt.phone,
          customerName:  appt.patient_name,
          variables: {
            patientName: appt.patient_name,
            service:     appt.service,
            callType:    'noshow',
            clinicName:  clinic.name,
            clinicPhone,
          },
        })

        if (ok) {
          console.log(`[noshow] Called ${appt.patient_name} for no-show follow-up`)
          await markContacted(clinic.id, appt.phone)
        }
      }

      // Send SMS as backup — fire and forget
      sendSMS(
        appt.phone,
        `Hi ${appt.patient_name}, we missed you at ${clinic.name} today for your ${appt.service}. Hope everything is okay! Call us at ${clinicPhone} to rebook whenever you are ready.`
      ).catch(err => console.error('[noshow] SMS error:', err))

      processed++
      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`[noshow] Done — processed: ${processed}, skipped: ${skipped}`)

    const result = { processed, skipped, total: appointments.length }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[noshow] Unhandled error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}