import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsUrgentMessage } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { MessageSchema } from '@/lib/validators'

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

    const validation = MessageSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'Could I get your name and a brief message for our team?')
    }

    const { patientName, patientPhone, message, urgency } = validation.data
    const phone  = formatPhone(patientPhone || '')
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)

    await supabase.from('messages').insert({
      clinic_id:    clinic?.id || null,
      patient_name: patientName || 'Unknown',
      phone:        phone || patientPhone || 'Unknown',
      message,
      urgency,
      status:       'unread',
      source:       'call',
      created_at:   new Date().toISOString(),
    })

    if ((urgency === 'urgent' || urgency === 'emergency') && clinic?.owner_phone) {
      await sendSMS(
        clinic.owner_phone,
        smsUrgentMessage(patientName || 'Unknown', phone || patientPhone || 'Unknown', message, urgency)
      )
    }

    const responses: Record<string, string> = {
      emergency: 'I have flagged this as urgent and our team will call you back within 30 minutes.',
      urgent:    'I have passed your message to our team and they will call you back as soon as possible.',
      routine:   'I have passed your message to our team and they will call you back within one business day.',
    }

    return vapiSuccess(toolCallId, responses[urgency] || responses.routine)
  } catch (err) {
    console.error('[message] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}