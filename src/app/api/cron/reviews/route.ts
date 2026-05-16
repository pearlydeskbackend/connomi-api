import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsReview } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isWithinCallingHours()) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const threeDaysAgo = new Date()
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    const targetDate = threeDaysAgo.toISOString().split('T')[0]

    console.log(`[reviews] Looking for appointments on ${targetDate}`)

    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(name, google_review_link, owner_phone)')
      .eq('date', targetDate)
      .in('status', ['Checked In', 'Confirmed'])
      .is('review_sent', null)
      .not('phone', 'is', null)

    if (error) {
      console.error('[reviews] Query error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log(`[reviews] No appointments found for ${targetDate}`)
      return NextResponse.json({ success: true, sent: 0, date: targetDate })
    }

    console.log(`[reviews] Found ${appointments.length} appointments to review`)

    let sent = 0
    let failed = 0

    for (const appt of appointments) {
      const clinic = appt.clinics as {
        name: string
        google_review_link: string | null
        owner_phone: string | null
      } | null

      if (!clinic) {
        console.warn(`[reviews] No clinic found for booking ${appt.id}`)
        continue
      }

      const reviewLink = clinic.google_review_link || 'https://g.page/r/review'

      const ok = await sendSMS(
        appt.phone,
        smsReview(appt.patient_name, clinic.name, reviewLink)
      )

      if (ok) {
        await supabase
          .from('bookings')
          .update({ review_sent: new Date().toISOString() })
          .eq('id', appt.id)

        console.log(`[reviews] Sent to ${appt.patient_name} (${appt.phone})`)
        sent++
      } else {
        console.error(`[reviews] SMS failed for ${appt.patient_name} (${appt.phone})`)
        failed++
      }

      await new Promise(r => setTimeout(r, 300))
    }

    return NextResponse.json({
      success: true,
      sent,
      failed,
      total: appointments.length,
      date: targetDate,
    })
  } catch (err) {
    console.error('[reviews] Unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}