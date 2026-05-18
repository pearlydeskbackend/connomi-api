import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsReview } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

// Check if a patient had any complaints or unresolved issues
// around the time of their appointment
async function hadComplaint(
  clinicId: string,
  phone: string,
  appointmentDate: string
): Promise<boolean> {
  const threeDaysBefore = new Date(appointmentDate)
  threeDaysBefore.setDate(threeDaysBefore.getDate() - 3)
  const threeDaysAfter = new Date(appointmentDate)
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3)

  // Check messages table for complaints around appointment date
  const { data: messages } = await supabase
    .from('messages')
    .select('id, urgency')
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

  // Check call_logs for unresolved calls
  const { data: calls } = await supabase
    .from('call_logs')
    .select('id, outcome')
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
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

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
      .not('phone', 'is', null)

    if (error) {
      console.error('[reviews] Query error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log(`[reviews] No appointments found for ${targetDate}`)
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

      // Skip patients who had complaints or unresolved issues
      const complaint = await hadComplaint(clinic.id, appt.phone, appt.date)
      if (complaint) {
        skipped++
        continue
      }

      const reviewLink = clinic.google_review_link || 'https://g.page/r/review'

      // Personalized review message referencing their specific service
      const message = smsReview(appt.patient_name, clinic.name, reviewLink)

      const ok = await sendSMS(appt.phone, message)

      if (ok) {
        await supabase
          .from('bookings')
          .update({ review_sent: new Date().toISOString() })
          .eq('id', appt.id)
        console.log(`[reviews] Sent to ${appt.patient_name} — ${appt.service}`)
        sent++
      } else {
        console.error(`[reviews] SMS failed for ${appt.patient_name}`)
        failed++
      }

      await new Promise(r => setTimeout(r, 300))
    }

    console.log(`[reviews] Done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`)

    return NextResponse.json({
      success: true,
      sent,
      failed,
      skipped,
      total: appointments.length,
      date: targetDate,
    })
  } catch (err) {
    console.error('[reviews] Unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}