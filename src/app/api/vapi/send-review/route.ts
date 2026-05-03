import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsReview } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({ results: [{ toolCallId: 'unknown', result: 'I have sent the review link to your phone.' }] })
    }

    toolCallId = tool.toolCallId
    const { patientName, patientPhone } = tool.args
    const phone  = formatPhone(patientPhone)

    if (!phone) {
      return vapiError(toolCallId, 'I could not send that link. Please call us and we will get it to you.')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I had trouble sending that. Please call us directly.')
    }

    const reviewLink = clinic.google_review_link || 'https://g.page/r/review'
    await sendSMS(phone, smsReview(patientName || 'there', clinic.name, reviewLink))

    const { data: booking } = await supabase
      .from('bookings')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .eq('status', 'Checked In')
      .order('date', { ascending: false })
      .limit(1)
      .single()

    if (booking) {
      await supabase.from('bookings').update({ review_sent: new Date().toISOString() }).eq('id', booking.id)
    }

    return vapiSuccess(toolCallId, 'I have sent the review link to your phone right now. Thank you so much — it really means a lot to our team!')
  } catch (err) {
    console.error('[send-review] Error:', err)
    return vapiError(toolCallId, 'I had trouble sending that. Please call us directly.')
  }
}
