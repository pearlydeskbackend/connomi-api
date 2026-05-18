import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  try {
    const now       = new Date().toISOString()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    console.log(`[noshow] Checking for no-shows on ${yesterdayStr}`)

    // Find appointments that were Confirmed yesterday but never
    // changed to Cancelled or Checked In — these are no-shows
    const { data: appointments, error } = await supabase
      .from('bookings')
      .select('*, clinics(id, name, owner_phone, twilio_phone, active)')
      .eq('date', yesterdayStr)
      .in('status', ['Confirmed', 'Patient Confirmed'])
      .is('no_show_at', null)
      .is('cancelled_at', null)

    if (error) {
      console.error('[noshow] Query error:', error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!appointments?.length) {
      console.log('[noshow] No no-shows detected')
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

      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

      console.log(`[noshow] ${appt.patient_name} — ${appt.service} — marking as no-show`)

      // Mark as no-show
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
        }
      }

      // Send SMS as backup
      await sendSMS(
        appt.phone,
        `Hi ${appt.patient_name}, we missed you at ${clinic.name} today for your ${appt.service}. Hope everything is okay! Call us at ${clinicPhone} to rebook whenever you are ready.`
      ).catch(err => console.error('[noshow] SMS error:', err))

      processed++
      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`[noshow] Done — processed: ${processed}, skipped: ${skipped}`)

    return NextResponse.json({
      success: true,
      processed,
      skipped,
      total: appointments.length,
    })

  } catch (err) {
    console.error('[noshow] Unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}