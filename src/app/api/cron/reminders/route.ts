import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsReminder } from '@/lib/twilio'
import { triggerVapiCall } from '@/lib/vapi'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

// High value services that get a Pearly voice reminder in addition to SMS
const HIGH_VALUE_SERVICES = [
  'root canal',
  'crown',
  'extraction',
  'implant',
  'surgery',
  'wisdom tooth',
  'bone graft',
  'bridge',
]

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0]

    const { data: appointments } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, owner_phone, twilio_phone)')
      .eq('date', tomorrowStr)
      .eq('status', 'Confirmed')
      .is('reminder_sent', null)

    if (!appointments?.length) return NextResponse.json({ success: true, sent: 0 })

    console.log(`[reminders] ${appointments.length} appointments due for reminders`)

    const assistantId   = process.env.VAPI_REMINDER_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    let sent  = 0
    let calls = 0

    for (const appt of appointments) {
      const clinic = appt.clinics as {
        id: string
        name: string
        owner_phone: string | null
        twilio_phone: string | null
      } | null

      if (!clinic) continue

      const clinicPhone  = clinic.twilio_phone || clinic.owner_phone || ''
      const isHighValue  = HIGH_VALUE_SERVICES.some(s =>
        appt.service.toLowerCase().includes(s)
      )

      // Send SMS reminder to all patients
      const ok = await sendSMS(
        appt.phone,
        smsReminder(appt.patient_name, appt.service, appt.date, appt.time, clinic.name, clinicPhone)
      )

      if (ok) {
        await supabase
          .from('bookings')
          .update({ reminder_sent: new Date().toISOString() })
          .eq('id', appt.id)
        sent++
        console.log(`[reminders] SMS sent to ${appt.patient_name} — ${appt.service}`)
      }

      // High value appointments also get a Pearly voice reminder
      if (isHighValue && assistantId && phoneNumberId) {
        const called = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: appt.phone,
          customerName:  appt.patient_name,
          variables: {
            patientName:     appt.patient_name,
            service:         appt.service,
            callType:        'reminder',
            appointmentTime: appt.time,
            appointmentDate: appt.date,
            clinicName:      clinic.name,
            clinicPhone,
          },
        })

        if (called) {
          calls++
          console.log(`[reminders] Voice reminder called for ${appt.patient_name} — ${appt.service}`)
        }
      }

      await new Promise(r => setTimeout(r, 300))
    }

    console.log(`[reminders] Done — SMS: ${sent}, calls: ${calls}, total: ${appointments.length}`)

    return NextResponse.json({ success: true, sent, calls, total: appointments.length })
  } catch (err) {
    console.error('[reminders] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}