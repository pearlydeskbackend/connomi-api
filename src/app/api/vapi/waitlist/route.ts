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

    // ── DEDUPLICATION CHECK ───────────────────────────────────────
    // Check waiting AND called — patient may have missed a call
    // but is still actively on the waitlist
    const { data: existing } = await supabase
      .from('waitlist')
      .select('id, status, service')
      .eq('clinic_id', clinic.id)
      .eq('phone', phone)
      .in('status', ['waiting', 'called'])
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    if (existing) {
      const statusMsg = existing.status === 'called'
        ? 'We actually just tried to reach you about an opening!'
        : 'You are already on our waitlist!'

      return vapiSuccess(
        toolCallId,
        `${statusMsg} We will call you as soon as a ${existing.service || 'slot'} opens up. Is there anything else I can help you with?`
      )
    }

    // ── TIME OF DAY PREFERENCE ────────────────────────────────────
    let preferredTimeOfDay: string | null = null
    if (preferredTimes) {
      const lower = preferredTimes.toLowerCase()
      if (lower.includes('morning'))        preferredTimeOfDay = 'morning'
      else if (lower.includes('afternoon')) preferredTimeOfDay = 'afternoon'
      else if (lower.includes('evening'))   preferredTimeOfDay = 'evening'
    }

    // ── DAY NUMBER CONVERSION ─────────────────────────────────────
    // "Monday and Wednesday" → "1,3"
    // Used by scoring algorithm for better candidate ranking
    let preferredDayNumbers: string | null = null
    if (preferredDays) {
      const lower   = preferredDays.toLowerCase()
      const dayMap: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6,
      }
      const nums: number[] = []
      for (const [name, num] of Object.entries(dayMap)) {
        if (lower.includes(name)) nums.push(num)
      }
      if (nums.length > 0) preferredDayNumbers = nums.join(',')
    }

    // ── INSERT ────────────────────────────────────────────────────
    const { error } = await supabase
      .from('waitlist')
      .insert({
        clinic_id:             clinic.id,
        patient_name:          patientName,
        phone,
        service:               service || null,
        preferred_days:        preferredDays || null,
        preferred_times:       preferredTimes || null,
        preferred_time_of_day: preferredTimeOfDay,
        preferred_day_numbers: preferredDayNumbers,
        status:                'waiting',
        attempt_count:         0,
        declined_count:        0,
        priority:              5,
        added_at:              new Date().toISOString(),
        expires_at:            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })

    if (error) {
      console.error('[waitlist] Insert error:', error.message)
      return vapiError(toolCallId, 'I had trouble adding you to the waitlist. Please call us directly.')
    }

    console.log(`[waitlist] Added ${patientName} (${phone}) for ${service || 'any service'} — tod: ${preferredTimeOfDay || 'any'} days: ${preferredDayNumbers || 'any'}`)

    return vapiSuccess(
      toolCallId,
      `You are on the waitlist! We will call you as soon as a ${service || 'slot'} opens up. Is there anything else I can help you with?`
    )

  } catch (err) {
    console.error('[waitlist] Unhandled error:', err)
    return vapiError(toolCallId, 'I am having some trouble. Please call us directly.')
  }
}