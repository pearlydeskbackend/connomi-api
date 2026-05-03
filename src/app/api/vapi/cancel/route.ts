import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsCancellation } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall, triggerVapiCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { CancelSchema } from '@/lib/validators'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: 'I am having trouble with our system. Please call us directly.' }]
      })
    }

    toolCallId = tool.toolCallId

    const validation = CancelSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'Could I get your name and phone number to find your booking?')
    }

    const { patientName, patientPhone } = validation.data

    const phone = formatPhone(patientPhone)
    if (!phone) {
      return vapiError(toolCallId, 'I could not verify that phone number. Could you repeat it?')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I am having trouble with our system. Please call us directly.')
    }

    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .in('status', ['Confirmed', 'Checked In'])
      .order('date', { ascending: false })
      .limit(1)
      .single()

    if (!booking) {
      return vapiError(toolCallId, 'I could not find a confirmed booking under that number. Could you double check or call us directly?')
    }

    await supabase.from('bookings').update({
      status:       'Cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }).eq('id', booking.id)

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    await sendSMS(phone, smsCancellation(patientName || booking.patient_name, booking.service, booking.date, booking.time, clinic.name, clinicPhone))

    // Fill slot from waitlist instantly
    const { data: nextOnWaitlist } = await supabase
      .from('waitlist')
      .select('*')
      .eq('clinic_id', clinic.id)
      .eq('status', 'waiting')
      .lt('call_attempts', 3)
      .order('added_at', { ascending: true })
      .limit(1)
      .single()

    if (nextOnWaitlist) {
      await supabase.from('waitlist').update({
        status:        'called',
        called_at:     new Date().toISOString(),
        call_attempts: (nextOnWaitlist.call_attempts || 0) + 1,
      }).eq('id', nextOnWaitlist.id)

      const waitlistAssistantId = process.env.VAPI_WAITLIST_ASSISTANT_ID || clinic.vapi_assistant_id
      const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

      if (waitlistAssistantId && phoneNumberId) {
        await triggerVapiCall({
          assistantId:   waitlistAssistantId,
          phoneNumberId,
          customerPhone: nextOnWaitlist.phone,
          customerName:  nextOnWaitlist.patient_name,
          variables: {
            availableDate: booking.date,
            availableTime: booking.time,
            service:       nextOnWaitlist.service,
            clinicName:    clinic.name,
            clinicPhone,
          },
        })
      }
    }

    return vapiSuccess(toolCallId, `Done. Your ${booking.service} on ${booking.date} at ${booking.time} has been cancelled. You will receive a confirmation text now.`)
  } catch (err) {
    console.error('[cancel] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}
