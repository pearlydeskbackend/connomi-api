import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsReview } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'
import {
  startCronLog,
  completeCronLog,
  failCronLog,
  wasContactedRecently,
  markContacted,
  claimBooking,
} from '@/lib/cron'

async function hadComplaint(
  clinicId: string,
  phone: string,
  appointmentDate: string
): Promise<boolean> {
  const threeDaysBefore = new Date(appointmentDate)
  threeDaysBefore.setDate(threeDaysBefore.getDate() - 3)
  const threeDaysAfter = new Date(appointmentDate)
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3)

  const { data: messages } = await supabase
    .from('messages')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('phone', phone)
    .in('urgency', ['urgent', 'emergency'])
    .gte('created_at', threeDaysBefore.toISOString())
    .lte('created_at', threeDaysAfter.toISOString())
    .limit(1)

  if (messages?.length) {
    console.log(`[reviews] Skipping ${phone} — had urgent message around appointment`)
    return true
  }

  const { data: calls } = await supabase
    .from('call_logs')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('outcome', 'unresolved')
    .gte('created_at', threeDaysBefore.toISOString())
    .lte('created_at', threeDaysAfter.toISOString())
    .limit(1)

  if (calls?.length) {
    console.log(`[reviews] Skipping ${phone} — had unresolved call around appointment`)
    return true
  }

  return false
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authorized = req.headers.get('x-cron-secret') === process.env.CRON_SECRET || req.headers.get('x-vercel-cron') === '1'
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  const logId = await startCronLog('reviews')

  try {
    const threeDaysAgo = new Date()
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    const targetDate = threeDaysAgo.toISOString().split('T')[0]

    console.log(`[reviews] Looking for appointments on ${targetDate}`)

    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, google_review_link, owner_phone, twilio_phone)')
      .eq('date', targetDate)
      .in('status', ['Checked In', 'Confirmed', 'Patient Confirmed'])
      .is('review_sent', null)
      .is('no_show_at', null)
      .is('cancelled_at', null)
      .is('deleted_at', null)
      .not('phone', 'is', null)

    if (error) {
      console.error('[reviews] Query error:', error.message)
      await failCronLog(logId, error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log(`[reviews] No appointments found for ${targetDate}`)
      await completeCronLog(logId, { sent: 0, skipped: 0, failed: 0, total: 0 })
      return NextResponse.json({ success: true, sent: 0, skipped: 0, date: targetDate })
    }

    console.log(`[reviews] Found ${appointments.length} appointments to review`)

    let sent    = 0
    let failed  = 0
    let skipped = 0

    for (const appt of appointments) {
      const clinic = appt.clinics as {
        id: string
        name: string
        google_review_link: string | null
        owner_phone: string | null
        twilio_phone: string | null
      } | null

      if (!clinic) continue

      const claimed = await claimBooking(appt.id, 'review_sent')
      if (!claimed) {
        console.log(`[reviews] ${appt.patient_name} — already claimed — skipping`)
        skipped++
        continue
      }

      const recentlyContacted = await wasContactedRecently(clinic.id, appt.phone)
      if (recentlyContacted) {
        console.log(`[reviews] ${appt.patient_name} — contacted recently — skipping`)
        skipped++
        continue
      }

      const complaint = await hadComplaint(clinic.id, appt.phone, appt.date)
      if (complaint) {
        skipped++
        continue
      }

      const reviewLink = clinic.google_review_link || 'https://g.page/r/review'
      const ok         = await sendSMS(appt.phone, smsReview(appt.patient_name, clinic.name, reviewLink))

      if (ok) {
        await supabase
          .from('bookings')
          .update({ review_sent: new Date().toISOString() })
          .eq('id', appt.id)
        await markContacted(clinic.id, appt.phone)
        console.log(`[reviews] Sent to ${appt.patient_name} — ${appt.service}`)
        sent++
      } else {
        console.error(`[reviews] SMS failed for ${appt.patient_name}`)
        failed++
      }

      await new Promise(r => setTimeout(r, 300))
    }

    console.log(`[reviews] Done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`)

    const result = { sent, failed, skipped, total: appointments.length, date: targetDate }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[reviews] Unhandled error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}