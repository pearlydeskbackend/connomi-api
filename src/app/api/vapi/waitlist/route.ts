import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'
import { formatPhone } from '@/lib/phone'
import { WaitlistSchema } from '@/lib/validators'

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

    const validation = WaitlistSchema.safeParse(tool.args)
    if (!validation.success) {
      return vapiError(toolCallId, 'Could I get your name and phone number to add you to the waitlist?')
    }

    const { patientName, patientPhone, service, preferredDays, preferredTimes } = validation.data

    const phone = formatPhone(patientPhone)
    if (!phone) {
      return vapiError(toolCallId, 'I could not verify that phone number. Could you repeat it?')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'I am having trouble with our system. Please call us directly.')
    }

    // Check if already on waitlist
    const { data: existing } = await supabase
      .from('waitlist')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .eq('status', 'waiting')
      .limit(1)
      .single()

    if (existing) {
      return vapiSuccess(toolCallId, 'You are already on our waitlist! We will call you as soon as a slot opens up.')
    }

    // Detect time of day preference from preferredTimes string
    let preferredTimeOfDay: string | null = null
    if (preferredTimes) {
      const lower = preferredTimes.toLowerCase()
      if (lower.includes('morning')) preferredTimeOfDay = 'morning'
      else if (lower.includes('afternoon')) preferredTimeOfDay = 'afternoon'
      else if (lower.includes('evening')) preferredTimeOfDay = 'evening'
    }

    const { error } = await supabase.from('waitlist').insert({
      clinic_id:             clinic.id,
      patient_name:          patientName,
      phone,
      service:               service || null,
      preferred_days:        preferredDays || null,
      preferred_times:       preferredTimes || null,
      preferred_time_of_day: preferredTimeOfDay,
      status:                'waiting',
      attempt_count:         0,
      priority:              5,
      added_at:              new Date().toISOString(),
      expires_at:            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })

    if (error) {
      console.error('[waitlist] Insert error:', error.message)
      return vapiError(toolCallId, 'I had trouble adding you to the waitlist. Please call us directly.')
    }

    console.log(`[waitlist] Added ${patientName} for ${service || 'any service'} — prefers ${preferredTimeOfDay || 'any time'}`)

    return vapiSuccess(
      toolCallId,
      `You are on the waitlist! We will call you as soon as a ${service || 'slot'} opens up. Is there anything else I can help you with?`
    )
  } catch (err) {
    console.error('[waitlist] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}