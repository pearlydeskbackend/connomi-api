import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({ results: [{ toolCallId: 'unknown', result: 'Perfect — we will see you then!' }] })
    }

    const phone  = formatPhone(tool.args.patientPhone || '')
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)

    if (phone && clinic) {
      await supabase
        .from('bookings')
        .update({ updated_at: new Date().toISOString() })
        .eq('clinic_id', clinic.id)
        .eq('phone', phone)
        .eq('status', 'Confirmed')
        .gte('date', new Date().toISOString().split('T')[0])
    }

    return vapiSuccess(tool.toolCallId, 'Perfect — we will see you then! Have a great day.')
  } catch (err) {
    console.error('[confirm] Error:', err)
    return NextResponse.json({ results: [{ toolCallId: 'unknown', result: 'Perfect — we will see you then!' }] })
  }
}
