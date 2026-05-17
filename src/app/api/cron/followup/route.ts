import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS, smsFollowup, smsFollowupLight } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

// Services that get a personal Pearly call — high value procedures
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

// Services that get a warm SMS only
const LIGHT_FOLLOWUP_SERVICES = [
  'cleaning',
  'filling',
  'whitening',
  'checkup',
  'exam',
  'x-ray',
  'invisalign',
]

function getFollowupType(service: string): 'call' | 'sms' | 'none' {
  const lower = service.toLowerCase()
  if (HIGH_VALUE_SERVICES.some(s => lower.includes(s))) return 'call'
  if (LIGHT_FOLLOWUP_SERVICES.some(s => lower.includes(s))) return 'sms'
  return 'sms' // default to SMS for anything else
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
    const now = new Date().toISOString()

    // Find appointments that happened 48 hours ago
    // Status must be Confirmed or Patient Confirmed — not Cancelled
    // followup_sent_at must be null — not already followed up
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    const sixtyHoursAgo      = new Date(Date.now() - 60 * 60 * 60 * 1000)

    const followupDateStart = fortyEightHoursAgo.toISOString().split('T')[0]
    const followupDateEnd   = sixtyHoursAgo.toISOString().split('T')[0]

    console.log(`[followup] Checking appointments between ${followupDateEnd} and ${followupDateStart}`)

    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])
      .gte('date', followupDateEnd)
      .lte('date', followupDateStart)
      .is('followup_sent_at', null)
      .not('service', 'ilike', '%consult%')
      .order('date', { ascending: true })
      .limit(20)

    if (error) {
      console.error('[followup] Query error:', error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log('[followup] No appointments due for follow-up')
      return NextResponse.json({ success: true, calls: 0, sms: 0 })
    }

    console.log(`[followup] ${appointments.length} appointments due for follow-up`)

    let calls   = 0
    let sms     = 0
    let skipped = 0

    const assistantId   = process.env.VAPI_REMINDER_ASSISTANT_ID
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

      const clinicPhone    = clinic.twilio_phone || clinic.owner_phone || ''
      const followupType   = getFollowupType(appt.service)

      console.log(`[followup] ${appt.patient_name} — ${appt.service} — type: ${followupType}`)

      let sent = false

      if (followupType === 'call' && assistantId && phoneNumberId) {
        // High value procedure — personal Pearly call
        sent = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: appt.phone,
          customerName:  appt.patient_name,
          variables: {
            patientName:  appt.patient_name,
            service:      appt.service,
            clinicName:   clinic.name,
            clinicPhone,
            appointmentDate: appt.date,
          },
        })

        if (sent) {
          calls++
          console.log(`[followup] Call triggered for ${appt.patient_name} — ${appt.service}`)
        }

      } else {
        // Light touch — warm SMS
        const isHighValue = followupType === 'call'
        sent = await sendSMS(
          appt.phone,
          isHighValue
            ? smsFollowup(appt.patient_name, appt.service, clinic.name, clinicPhone)
            : smsFollowupLight(appt.patient_name, appt.service, clinic.name, clinicPhone)
        )

        if (sent) {
          sms++
          console.log(`[followup] SMS sent to ${appt.patient_name} — ${appt.service}`)
        }
      }

      // Mark as followed up regardless of send result
      // to prevent double sending
      if (sent) {
        await supabase
          .from('bookings')
          .update({
            followup_sent_at: now,
            followup_type:    followupType,
            updated_at:       now,
          })
          .eq('id', appt.id)
      }

      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`[followup] Done — calls: ${calls}, sms: ${sms}, skipped: ${skipped}`)

    return NextResponse.json({
      success: true,
      calls,
      sms,
      skipped,
      total: appointments.length,
    })

  } catch (err) {
    console.error('[followup] Unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}