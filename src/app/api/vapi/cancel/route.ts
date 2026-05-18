import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS, smsCancellation } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
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

    const today = new Date().toISOString().split('T')[0]
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .in('status', ['Confirmed', 'Checked In', 'Patient Confirmed'])
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(1)
      .single()

    if (!booking) {
      return vapiError(toolCallId, 'I could not find a confirmed booking under that number. Could you double check or call us directly?')
    }

    // Cancel the booking
    await supabase.from('bookings').update({
      status:       'Cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }).eq('id', booking.id)

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''

    // Send cancellation SMS — fire and forget
    sendSMS(phone, smsCancellation(
      patientName || booking.patient_name,
      booking.service, booking.date, booking.time,
      clinic.name, clinicPhone
    )).catch(err => console.error('[cancel] SMS error:', err))

    // Only try to fill if slot is more than 2 hours away
    const slotDateTime = new Date(`${booking.date}T${convertTo24h(booking.time)}`)
    const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60)

    if (hoursUntilSlot > 2) {
      // Create cancelled slot record
      const { data: slotRecord } = await supabase
        .from('cancelled_slots')
        .insert({
          clinic_id:  clinic.id,
          booking_id: booking.id,
          service:    booking.service,
          slot_date:  booking.date,
          slot_time:  booking.time,
          status:     'open',
        })
        .select()
        .single()

      if (slotRecord) {
        // Trigger fill engine — fire and forget
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'
        fetch(`${appUrl}/api/internal/fill-slot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.CRON_SECRET || '',
          },
          body: JSON.stringify({ slotId: slotRecord.id }),
        }).catch(err => console.error('[cancel] Fill trigger error:', err))
      }
    } else {
      console.log(`[cancel] Slot in ${hoursUntilSlot.toFixed(1)}h — too soon to fill via waitlist`)
    }

    console.log(`[cancel] Cancelled — ${booking.patient_name} ${booking.service} ${booking.date} ${booking.time}`)

    return vapiSuccess(
      toolCallId,
      `Done. Your ${booking.service} on ${booking.date} at ${booking.time} has been cancelled. You will receive a confirmation text now. Would you like to rebook for another time or join our waitlist?`
    )
  } catch (err) {
    console.error('[cancel] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}

function convertTo24h(time: string): string {
  const match = time.match(/(\d+):(\d+)\s*(AM|PM)/i)
  if (!match) return '12:00:00'
  let hour = parseInt(match[1])
  const min = match[2]
  const period = match[3].toUpperCase()
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${min}:00`
}