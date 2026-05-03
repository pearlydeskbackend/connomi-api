import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsReschedule } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { RescheduleSchema } from '@/lib/validators'

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

    const validation = RescheduleSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'I need your phone number and the new date and time you would like.')
    }

    const { patientName, patientPhone, newDate, newTime } = validation.data

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
      return vapiError(toolCallId, 'I could not find a booking under that number. Could you double check or call us directly?')
    }

    await supabase.from('bookings').update({
      date:       newDate,
      time:       newTime,
      updated_at: new Date().toISOString(),
    }).eq('id', booking.id)

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    await sendSMS(phone, smsReschedule(patientName || booking.patient_name, booking.service, newDate, newTime, clinic.name, clinicPhone))

    return vapiSuccess(toolCallId, `Done! Your ${booking.service} has been moved to ${newDate} at ${newTime}. You will receive a confirmation text now. See you then!`)
  } catch (err) {
    console.error('[reschedule] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}
