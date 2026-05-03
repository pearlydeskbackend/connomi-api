import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { getClinicByPhone } from '@/lib/clinic'
import { sendSMS, smsCancellation, smsSmsReply } from '@/lib/twilio'
import { formatPhone } from '@/lib/phone'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const twiml   = '<?xml version="1.0"?><Response></Response>'
  const headers = { 'Content-Type': 'text/xml' }

  try {
    const formData = await req.formData()
    const from     = formData.get('From') as string
    const to       = formData.get('To') as string
    const rawBody  = formData.get('Body') as string
    const message  = rawBody?.trim().toLowerCase() || ''

    if (!from || !to || !rawBody) return new NextResponse(twiml, { headers })

    const clinic = await getClinicByPhone(to)
    if (!clinic) return new NextResponse(twiml, { headers })

    const phone       = formatPhone(from)
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    const today       = new Date().toISOString().split('T')[0]

    if (message === 'cancel' || message === 'stop booking') {
      const { data: booking } = await supabase
        .from('bookings').select('*')
        .eq('clinic_id', clinic.id).eq('phone', phone || from)
        .in('status', ['Confirmed']).gte('date', today)
        .order('date', { ascending: true }).limit(1).single()

      if (booking) {
        await supabase.from('bookings').update({
          status: 'Cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', booking.id)
        await sendSMS(from, smsCancellation(booking.patient_name, booking.service, booking.date, booking.time, clinic.name, clinicPhone))
      } else {
        await sendSMS(from, `We could not find an upcoming booking under this number. Call ${clinicPhone} for help.`)
      }
    }

    else if (['confirm', 'yes', 'c', 'confirmed'].includes(message)) {
      const { data: booking } = await supabase
        .from('bookings').select('*')
        .eq('clinic_id', clinic.id).eq('phone', phone || from)
        .eq('status', 'Confirmed').gte('date', today)
        .order('date', { ascending: true }).limit(1).single()

      if (booking) {
        await sendSMS(from, `Confirmed! We will see you on ${booking.date} at ${booking.time} at ${clinic.name}.`)
      }
    }

    else if (['stop', 'unsubscribe', 'quit', 'end'].includes(message)) {
      if (phone) {
        await supabase.from('patients').update({
          recall_called_at: '2099-01-01T00:00:00.000Z',
          recall_attempts:  99,
        }).eq('clinic_id', clinic.id).eq('phone', phone)
      }
    }

    else {
      await supabase.from('messages').insert({
        clinic_id: clinic.id, patient_name: 'SMS Reply',
        phone: phone || from, message: rawBody,
        urgency: 'routine', status: 'unread', source: 'sms',
        created_at: new Date().toISOString(),
      })
      await sendSMS(from, smsSmsReply(clinic.name, clinicPhone))
    }

    return new NextResponse(twiml, { headers })
  } catch (err) {
    console.error('[twilio/webhook] Error:', err)
    return new NextResponse(twiml, { headers })
  }
}
