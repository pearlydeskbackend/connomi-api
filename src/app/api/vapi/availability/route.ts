import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { AvailabilitySchema } from '@/lib/validators'

const ALL_SLOTS = [
  '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM',
  '11:00 AM', '11:30 AM', '1:00 PM', '1:30 PM',
  '2:00 PM', '2:30 PM', '3:00 PM', '3:30 PM',
  '4:00 PM', '4:30 PM',
]

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: 'I could not check availability. Please call us directly.' }]
      })
    }

    toolCallId = tool.toolCallId

    const validation = AvailabilitySchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'Which date would you like to check availability for?')
    }

    const { date } = validation.data
    const today = new Date().toISOString().split('T')[0]

    if (date < today) {
      return vapiError(toolCallId, 'That date has already passed. Could you choose a future date?')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I am having trouble checking availability. Please call us directly.')
    }

    const { data: booked } = await supabase
      .from('bookings')
      .select('time')
      .eq('clinic_id', clinic.id)
      .eq('date', date)
      .neq('status', 'Cancelled')

    const bookedTimes = booked?.map(b => b.time) || []
    const available   = ALL_SLOTS.filter(slot => !bookedTimes.includes(slot))

    if (available.length === 0) {
      return NextResponse.json({ results: [{ toolCallId, result: `NONE_AVAILABLE:${date}` }] })
    }

    return NextResponse.json({ results: [{ toolCallId, result: `AVAILABLE:${available.slice(0, 3).join(',')}` }] })
  } catch (err) {
    console.error('[availability] Unhandled error:', err)
    return vapiError(toolCallId, 'I could not check availability right now. Please call us directly.')
  }
}
