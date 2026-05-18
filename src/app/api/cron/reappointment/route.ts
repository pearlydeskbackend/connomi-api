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

  const logId = await startCronLog('reappointment')

  try {
    const now          = new Date().toISOString()
    const yesterday    = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    console.log(`[reappointment] Checking patients seen on ${yesterdayStr}`)

    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .eq('date', yesterdayStr)
      .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])
      .is('reappointment_sent_at', null)
      .is('deleted_at', null)

    if (error) {
      console.error('[reappointment] Query error:', error.message)
      await failCronLog(logId, error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log('[reappointment] No patients to follow up with')
      await completeCronLog(logId, { called: 0, skipped: 0, total: 0 })
      return NextResponse.json({ success: true, called: 0, skipped: 0 })
    }

    console.log(`[reappointment] ${appointments.length} patients to check`)

    let called  = 0
    let skipped = 0

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
      // Prevents overlap with noshow cron which runs after this
      const recentlyContacted = await wasContactedRecently(clinic.id, appt.phone)
      if (recentlyContacted) {
        console.log(`[reappointment] ${appt.patient_name} — contacted recently — skipping`)
        skipped++

        // Mark as handled to prevent noshow cron from also calling
        await supabase
          .from('bookings')
          .update({ reappointment_sent_at: now, updated_at: now })
          .eq('id', appt.id)

        continue
      }

      // Check if patient already has a future booking
      const { data: futureBooking } = await supabase
        .from('bookings')
        .select('id')
        .eq('clinic_id', clinic.id)
        .eq('phone', appt.phone)
        .in('status', ['Confirmed', 'Patient Confirmed'])
        .gt('date', yesterdayStr)
        .limit(1)
        .single()

      if (futureBooking) {
        console.log(`[reappointment] ${appt.patient_name} already has future booking — skipping`)
        skipped++

        // Mark as handled so noshow cron does not double contact
        await supabase
          .from('bookings')
          .update({ reappointment_sent_at: now, updated_at: now })
          .eq('id', appt.id)

        continue
      }

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      console.log(`[reappointment] ${appt.patient_name} — ${appt.service} — no future booking`)

      // Call the patient to rebook
      if (assistantId && phoneNumberId) {
        const ok = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: appt.phone,
          customerName:  appt.patient_name,
          variables: {
            patientName: appt.patient_name,
            service:     appt.service,
            callType:    'reappointment',
            clinicName:  clinic.name,
            clinicPhone,
          },
        })

        if (ok) {
          called++
          console.log(`[reappointment] Called ${appt.patient_name} to rebook`)

          // Mark contacted for rate limiting — prevents noshow cron overlap
          await markContacted(clinic.id, appt.phone)

          // Send SMS immediately as backup
          sendSMS(
            appt.phone,
            `Hi ${appt.patient_name}, it was great seeing you at ${clinic.name} yesterday! We noticed you did not get a chance to book your next visit. Call us at ${clinicPhone} whenever you are ready. — Pearly Desk`
          ).catch(err => console.error('[reappointment] SMS error:', err))

          await supabase
            .from('bookings')
            .update({ reappointment_sent_at: now, updated_at: now })
            .eq('id', appt.id)
        }
      }

      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`[reappointment] Done — called: ${called}, skipped: ${skipped}`)

    const result = { called, skipped, total: appointments.length }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[reappointment] Unhandled error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}