import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsConfirmation } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { BookingSchema } from '@/lib/validators'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: 'I am having trouble with our system. Please call us directly at 604-879-9999.' }]
      })
    }

    toolCallId = tool.toolCallId

    const validation = BookingSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'I am missing some details. Could you give me your full name, phone number, the service, date and time?')
    }

    const { patientName, patientPhone, service, date, time, isNewPatient, notes } = validation.data

    const phone = formatPhone(patientPhone)
    if (!phone) {
      return vapiError(toolCallId, 'I could not verify that phone number. Could you repeat it slowly?')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I am having trouble with our system. Please call us directly.')
    }

    const today = new Date().toISOString().split('T')[0]

    // Check for duplicate upcoming booking
    const { data: existing } = await supabase
      .from('bookings')
      .select('id, date, time, service')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .eq('status', 'Confirmed')
      .gte('date', today)
      .limit(1)
      .single()

    if (existing) {
      return vapiSuccess(
        toolCallId,
        `I can see you already have a ${existing.service} booked for ${existing.date} at ${existing.time}. Would you like to keep that, reschedule it, or book an additional appointment?`
      )
    }

    // Insert booking with 8 second timeout
    const { error: bookingError } = await Promise.race([
      supabase.from('bookings').insert({
        clinic_id:      clinic.id,
        patient_name:   patientName,
        phone,
        service,
        date,
        time,
        status:         'Confirmed',
        is_new_patient: isNewPatient,
        booked_by:      'pearly',
        notes,
        created_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }),
      new Promise<{ error: Error }>((resolve) =>
        setTimeout(() => resolve({ error: new Error('Insert timed out') }), 8000)
      ),
    ]) as { error: Error | null }

    if (bookingError) {
      console.error('[book] Insert error:', bookingError.message)
      return vapiError(toolCallId, 'I am having trouble completing that booking. Please call us directly.')
    }

    // Upsert patient record — fire and forget
    const patientUpsert = supabase.from('patients').upsert(
      {
        clinic_id:    clinic.id,
        patient_name: patientName,
        phone,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: 'clinic_id,phone' }
    )
    Promise.resolve(patientUpsert).catch((err: unknown) => {
      console.error('[book] Patient upsert error:', err)
    })

    // Send SMS — fire and forget, never block the response
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    sendSMS(phone, smsConfirmation(patientName, service, date, time, clinic.name, clinicPhone))
      .then((sent) => {
        console.log('[book] SMS sent:', sent)
      })
      .catch((err: unknown) => {
        console.error('[book] SMS error:', err)
      })

    // Return success immediately — do not wait for SMS or patient upsert
    console.log(`[book] Booking saved — ${patientName} ${service} ${date} at ${clinic.name}`)

    return vapiSuccess(
      toolCallId,
      `You are all set! Your ${service} is booked for ${date} at ${time}. You will receive a confirmation text shortly. Is there anything else I can help you with?`
    )
  } catch (err) {
    console.error('[book] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}