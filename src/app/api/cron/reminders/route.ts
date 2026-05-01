import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsReminder } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isWithinCallingHours()) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0]

    const { data: appointments } = await supabase
      .from('bookings')
      .select('*, clinics(name, owner_phone, twilio_phone)')
      .eq('date', tomorrowStr)
      .eq('status', 'Confirmed')
      .is('reminder_sent', null)

    if (!appointments?.length) return NextResponse.json({ success: true, sent: 0 })

    let sent = 0
    for (const appt of appointments) {
      const clinic = appt.clinics as { name: string; owner_phone: string | null; twilio_phone: string | null } | null
      if (!clinic) continue
      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
      const ok = await sendSMS(appt.phone, smsReminder(appt.patient_name, appt.service, appt.date, appt.time, clinic.name, clinicPhone))
      if (ok) {
        await supabase.from('bookings').update({ reminder_sent: new Date().toISOString() }).eq('id', appt.id)
        sent++
      }
      await new Promise(r => setTimeout(r, 300))
    }

    return NextResponse.json({ success: true, sent, total: appointments.length })
  } catch (err) {
    console.error('[reminders] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}