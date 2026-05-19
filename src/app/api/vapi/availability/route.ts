import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, extractToolCall } from '@/lib/vapi'

// ─── CACHE ────────────────────────────────────────────────────────────────────
const bookingCache = new Map<string, {
  data: Array<{ time: string; duration: number }>
  expires: number
}>()

async function getBookedSlots(
  clinicId: string,
  date: string
): Promise<Array<{ time: string; duration: number }>> {
  const key    = `${clinicId}:${date}`
  const cached = bookingCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.data

  const { data: durations } = await supabase
    .from('service_durations')
    .select('service, duration_minutes')
    .eq('clinic_id', clinicId)

  const durationMap = new Map<string, number>()
  for (const d of durations || []) {
    durationMap.set(d.service.toLowerCase(), d.duration_minutes)
  }

  const [pearly, pms] = await Promise.all([
    supabase
      .from('bookings')
      .select('time, service')
      .eq('clinic_id', clinicId)
      .eq('date', date)
      .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In']),

    supabase
      .from('pms_bookings')
      .select('slot_time, title')
      .eq('clinic_id', clinicId)
      .eq('slot_date', date)
      .neq('status', 'free'),
  ])

  const slots: Array<{ time: string; duration: number }> = []

  for (const b of pearly.data || []) {
    const duration = durationMap.get((b.service || '').toLowerCase()) || 30
    slots.push({ time: b.time, duration })
  }
  for (const b of pms.data || []) {
    const duration = durationMap.get((b.title || '').toLowerCase()) || 30
    slots.push({ time: b.slot_time, duration })
  }

  bookingCache.set(key, { data: slots, expires: Date.now() + 60000 })
  return slots
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  if (!t) return 0
  const ampm = t.match(/^(\d+):(\d+)\s*(AM|PM)$/i)
  if (ampm) {
    let h = parseInt(ampm[1])
    const m = parseInt(ampm[2])
    const p = ampm[3].toUpperCase()
    if (p === 'PM' && h !== 12) h += 12
    if (p === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  const plain = t.match(/^(\d+):(\d+)$/)
  if (plain) return parseInt(plain[1]) * 60 + parseInt(plain[2])
  return 0
}

function minutesToTime(m: number): string {
  const h24    = Math.floor(m / 60)
  const min    = m % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12    = h24 > 12 ? h24 - 12 : h24 === 0 ? 12 : h24
  return `${h12}:${String(min).padStart(2, '0')} ${period}`
}

// Duration-aware overlap detection
// crown at 10:00 AM (90 min) → blocks 10:30 AM slot
function isSlotBlocked(
  requestedTime:     string,
  requestedDuration: number,
  bookedSlots:       Array<{ time: string; duration: number }>
): boolean {
  const reqStart = timeToMinutes(requestedTime)
  const reqEnd   = reqStart + requestedDuration

  for (const slot of bookedSlots) {
    const slotStart = timeToMinutes(slot.time)
    const slotEnd   = slotStart + slot.duration
    if (reqStart < slotEnd && reqEnd > slotStart) return true
  }
  return false
}

function generateSlots(openTime: string, closeTime: string, duration: number): string[] {
  const slots: string[] = []
  let current = timeToMinutes(openTime)
  const end   = timeToMinutes(closeTime)
  while (current + duration <= end) {
    slots.push(minutesToTime(current))
    current += duration
  }
  return slots
}

function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d + n).toISOString().split('T')[0]
}

function speakableSlot(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt        = new Date(y, m - 1, d)
  const dayName   = dt.toLocaleDateString('en-CA', { weekday: 'long' })
  const monthName = dt.toLocaleDateString('en-CA', { month: 'long' })
  return `${dayName} the ${d} of ${monthName} at ${time}`
}

// ─── ALTERNATIVES ─────────────────────────────────────────────────────────────

async function findAlternatives(
  clinicId:          string,
  fromDate:          string,
  openDays:          number[],
  holidays:          string[],
  openTime:          string,
  closeTime:         string,
  slotDuration:      number,
  requestedDuration: number,
  excludeTime?:      string,
  count = 2
): Promise<{ date: string; time: string }[]> {
  const results: { date: string; time: string }[] = []
  let checkDate   = fromDate
  let daysChecked = 0

  while (results.length < count && daysChecked < 21) {
    const dow = getDayOfWeek(checkDate)

    if (openDays.includes(dow) && !holidays.includes(checkDate)) {
      const slots       = generateSlots(openTime, closeTime, slotDuration)
      const bookedSlots = await getBookedSlots(clinicId, checkDate)

      for (const slot of slots) {
        if (results.length >= count) break
        if (slot === excludeTime && checkDate === fromDate) continue
        if (!isSlotBlocked(slot, requestedDuration, bookedSlots)) {
          results.push({ date: checkDate, time: slot })
        }
      }
    }

    checkDate = addDays(checkDate, 1)
    daysChecked++
  }

  return results
}

// ─── SPEECH ───────────────────────────────────────────────────────────────────

function buildSuggestion(
  reason:       string,
  alternatives: { date: string; time: string }[],
  dayName?:     string,
  openTime?:    string,
  closeTime?:   string
): string {
  const hasTwo = alternatives.length >= 2

  if (reason === 'holiday') {
    return hasTwo
      ? `That day is a statutory holiday so we are closed. I have got ${speakableSlot(alternatives[0].date, alternatives[0].time)}, or ${speakableSlot(alternatives[1].date, alternatives[1].time)} — which works better?`
      : `That day is a statutory holiday so we are closed. What other day works for you?`
  }
  if (reason === 'closed') {
    return hasTwo
      ? `We are actually closed on ${dayName}s. I have got ${speakableSlot(alternatives[0].date, alternatives[0].time)}, or ${speakableSlot(alternatives[1].date, alternatives[1].time)} — which works better?`
      : `We are closed on ${dayName}s. What other day works for you?`
  }
  if (reason === 'outside_hours') {
    const openStr  = minutesToTime(timeToMinutes(openTime  || '09:30'))
    const closeStr = minutesToTime(timeToMinutes(closeTime || '17:30'))
    return hasTwo
      ? `That time is outside our hours — we are open ${openStr} to ${closeStr}. I have got ${speakableSlot(alternatives[0].date, alternatives[0].time)}, or ${speakableSlot(alternatives[1].date, alternatives[1].time)} — which works better?`
      : `That time is outside our hours — we are open ${openStr} to ${closeStr}. What time works for you?`
  }
  if (reason === 'booked') {
    return hasTwo
      ? `That slot is taken. I have got ${speakableSlot(alternatives[0].date, alternatives[0].time)}, or ${speakableSlot(alternatives[1].date, alternatives[1].time)} — which works better?`
      : `That slot is taken. What other time works for you?`
  }
  return `Let me find another time for you.`
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: JSON.stringify({ available: true }) }]
      })
    }

    toolCallId = tool.toolCallId

    const { requestedDate, requestedTime, service } = tool.args as {
      requestedDate?: string
      requestedTime?: string
      service?:       string
    }

    if (!requestedDate || !requestedTime) {
      return vapiSuccess(toolCallId, JSON.stringify({ available: true }))
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiSuccess(toolCallId, JSON.stringify({ available: true, message: 'Could not verify — proceed with booking.' }))
    }

    const openTime:    string = (clinic as any).open_time           || '09:30'
    const closeTime:   string = (clinic as any).close_time          || '17:30'
    const slotDur:     number = (clinic as any).slot_duration_minutes || 30
    const openDaysStr: string = (clinic as any).open_days           || '1,2,3,4,5,6'
    const holidayStr:  string = (clinic as any).holiday_dates       || ''

    const openDays: number[] = openDaysStr.split(',').map(Number).filter(n => !isNaN(n))
    const holidays: string[] = holidayStr ? holidayStr.split(',').map((h: string) => h.trim()) : []

    // Get service-specific duration
    let requestedDuration = slotDur
    if (service) {
      const { data: svcDuration } = await supabase
        .from('service_durations')
        .select('duration_minutes')
        .eq('clinic_id', clinic.id)
        .ilike('service', `%${service.toLowerCase()}%`)
        .limit(1)
        .maybeSingle()

      if (svcDuration) requestedDuration = svcDuration.duration_minutes
    }

    console.log(`[availability] ${clinic.name} | ${requestedDate} ${requestedTime} | service: ${service} | duration: ${requestedDuration}min`)

    const dow     = getDayOfWeek(requestedDate)
    const [y, m, d] = requestedDate.split('-').map(Number)
    const dayName = new Date(y, m - 1, d).toLocaleDateString('en-CA', { weekday: 'long' })

    // 1 — Holiday
    if (holidays.includes(requestedDate)) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, slotDur, requestedDuration)
      return vapiSuccess(toolCallId, JSON.stringify({ available: false, reason: 'holiday', alternatives, speechSuggestion: buildSuggestion('holiday', alternatives) }))
    }

    // 2 — Closed day
    if (!openDays.includes(dow)) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, slotDur, requestedDuration)
      return vapiSuccess(toolCallId, JSON.stringify({ available: false, reason: 'closed', alternatives, speechSuggestion: buildSuggestion('closed', alternatives, dayName) }))
    }

    // 3 — Outside hours (including if appointment would end after close)
    const reqMins   = timeToMinutes(requestedTime)
    const openMins  = timeToMinutes(openTime)
    const closeMins = timeToMinutes(closeTime)

    if (reqMins < openMins || reqMins >= closeMins || (reqMins + requestedDuration) > closeMins) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, slotDur, requestedDuration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({ available: false, reason: 'outside_hours', alternatives, speechSuggestion: buildSuggestion('outside_hours', alternatives, dayName, openTime, closeTime) }))
    }

    // 4 — Duration-aware overlap check
    const bookedSlots = await getBookedSlots(clinic.id, requestedDate)
    const isBlocked   = isSlotBlocked(requestedTime, requestedDuration, bookedSlots)

    if (isBlocked) {
      console.log(`[availability] blocked — ${requestedDate} ${requestedTime} (${requestedDuration}min)`)
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, slotDur, requestedDuration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({ available: false, reason: 'booked', alternatives, speechSuggestion: buildSuggestion('booked', alternatives) }))
    }

    // 5 — Available
    console.log(`[availability] available — ${requestedDate} ${requestedTime} (${requestedDuration}min)`)
    return vapiSuccess(toolCallId, JSON.stringify({
      available:        true,
      date:             requestedDate,
      time:             requestedTime,
      speechSuggestion: `That works — so ${speakableSlot(requestedDate, requestedTime)}. Does that sound right?`,
    }))

  } catch (err) {
    console.error('[availability] Unhandled error:', err)
    return vapiSuccess(toolCallId, JSON.stringify({ available: true, message: 'Could not verify — proceed with booking.' }))
  }
}