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

    const { data: appointments } = await supabase
      .from('bookings')
      .select('*, clinics(name, google_review_link)')
      .eq('date', threeDaysAgo.toISOString().split('T')[0])
      .eq('status', 'Checked In')
      .is('review_sent', null)

    if (!appointments?.length) return NextResponse.json({ success: true, sent: 0 })

    let sent = 0
    for (const appt of appointments) {
      const clinic = appt.clinics as { name: string; google_review_link: string | null } | null
      if (!clinic) continue
      const ok = await sendSMS(appt.phone, smsReview(appt.patient_name, clinic.name, clinic.google_review_link || 'https://g.page/r/review'))
      if (ok) {
        await supabase.from('bookings').update({ review_sent: new Date().toISOString() }).eq('id', appt.id)
        sent++
      }
      await new Promise(r => setTimeout(r, 300))
    }

    return NextResponse.json({ success: true, sent, total: appointments.length })
  } catch (err) {
    console.error('[reviews] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
