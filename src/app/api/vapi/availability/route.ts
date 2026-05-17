import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, extractToolCall } from '@/lib/vapi'

// Simple in-memory cache — 60 second TTL
const bookingCache = new Map<string, { data: string[]; expires: number }>()

async function getBookedTimes(clinicId: string, date: string): Promise<Set<string>> {
  const key = `${clinicId}:${date}`
  const cached = bookingCache.get(key)
  if (cached && cached.expires > Date.now()) return new Set(cached.data)

  const { data } = await supabase
    .from('bookings')
    .select('time')
    .eq('clinic_id', clinicId)
    .eq('date', date)
    .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])

  const times = (data || []).map((b: any) => b.time)
  bookingCache.set(key, { data: times, expires: Date.now() + 60000 })
  return new Set(times)
}

function timeToMinutes(t: string): number {
  // Handles both "09:30" and "9:30 AM" formats
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
  const h24 = Math.floor(m / 60)
  const min = m % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 > 12 ? h24 - 12 : h24 === 0 ? 12 : h24
  return `${h12}:${String(min).padStart(2, '0')} ${period}`
}

function generateSlots(openTime: string, closeTime: string, duration: number): string[] {
  const slots: string[] = []
  let current = timeToMinutes(openTime)
  const end = timeToMinutes(closeTime)
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
  const date = new Date(y, m - 1, d + n)
  return date.toISOString().split('T')[0]
}

function speakableSlot(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dayName = dt.toLocaleDateString('en-CA', { weekday: 'long' })
  const monthName = dt.toLocaleDateString('en-CA', { month: 'long' })
  return `${dayName} the ${d} of ${monthName} at ${time}`
}

async function findAlternatives(
  clinicId: string,
  fromDate: string,
  openDays: number[],
  holidays: string[],
  openTime: string,
  closeTime: string,
  duration: number,
  excludeTime?: string,
  count = 2
): Promise<{ date: string; time: string }[]> {
  const results: { date: string; time: string }[] = []
  let checkDate = fromDate
  let daysChecked = 0

  while (results.length < count && daysChecked < 21) {
    const dow = getDayOfWeek(checkDate)

    if (openDays.includes(dow) && !holidays.includes(checkDate)) {
      const slots = generateSlots(openTime, closeTime, duration)
      const booked = await getBookedTimes(clinicId, checkDate)

      for (const slot of slots) {
        if (results.length >= count) break
        if (slot === excludeTime && checkDate === fromDate) continue
        if (!booked.has(slot)) {
          results.push({ date: checkDate, time: slot })
        }
      }
    }

    checkDate = addDays(checkDate, 1)
    daysChecked++
  }

  return results
}

function buildSuggestion(reason: string, alternatives: { date: string; time: string }[], dayName?: string, openTime?: string, closeTime?: string): string {
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
    const openStr = minutesToTime(timeToMinutes(openTime || '09:30'))
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

    const { requestedDate, requestedTime } = tool.args as {
      requestedDate?: string
      requestedTime?: string
    }

    if (!requestedDate || !requestedTime) {
      return vapiSuccess(toolCallId, JSON.stringify({ available: true }))
    }

    // Resolve clinic
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      console.error('[availability] Could not resolve clinic')
      return vapiSuccess(toolCallId, JSON.stringify({ available: true, message: 'Could not verify — proceed with booking.' }))
    }

    // Read clinic config — simple text fields, no jsonb parsing
    const openTime: string = (clinic as any).open_time || '09:30'
    const closeTime: string = (clinic as any).close_time || '17:30'
    const duration: number = (clinic as any).slot_duration_minutes || 30
    const openDaysStr: string = (clinic as any).open_days || '1,2,3,4,5,6'
    const holidayStr: string = (clinic as any).holiday_dates || ''

    const openDays: number[] = openDaysStr.split(',').map(Number).filter(n => !isNaN(n))
    const holidays: string[] = holidayStr ? holidayStr.split(',').map((h: string) => h.trim()) : []

    console.log('[availability] clinic:', clinic.name)
    console.log('[availability] openDays:', openDays, 'openTime:', openTime, 'closeTime:', closeTime)
    console.log('[availability] checking:', requestedDate, requestedTime)

    const dow = getDayOfWeek(requestedDate)
    const [y, m, d] = requestedDate.split('-').map(Number)
    const dayName = new Date(y, m - 1, d).toLocaleDateString('en-CA', { weekday: 'long' })

    // 1 — Holiday check
    if (holidays.includes(requestedDate)) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, duration)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'holiday',
        alternatives,
        speechSuggestion: buildSuggestion('holiday', alternatives),
      }))
    }

    // 2 — Closed day check
    if (!openDays.includes(dow)) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, duration)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'closed',
        alternatives,
        speechSuggestion: buildSuggestion('closed', alternatives, dayName),
      }))
    }

    // 3 — Outside hours check
    const reqMins = timeToMinutes(requestedTime)
    const openMins = timeToMinutes(openTime)
    const closeMins = timeToMinutes(closeTime)

    if (reqMins < openMins || reqMins >= closeMins) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, duration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'outside_hours',
        alternatives,
        speechSuggestion: buildSuggestion('outside_hours', alternatives, dayName, openTime, closeTime),
      }))
    }

    // 4 — Already booked check
    const booked = await getBookedTimes(clinic.id, requestedDate)
    if (booked.has(requestedTime)) {
      const alternatives = await findAlternatives(clinic.id, requestedDate, openDays, holidays, openTime, closeTime, duration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'booked',
        alternatives,
        speechSuggestion: buildSuggestion('booked', alternatives),
      }))
    }

    // 5 — Available
    console.log('[availability] slot available:', requestedDate, requestedTime)
    return vapiSuccess(toolCallId, JSON.stringify({
      available: true,
      date: requestedDate,
      time: requestedTime,
      speechSuggestion: `That works — so ${speakableSlot(requestedDate, requestedTime)}. Does that sound right?`,
    }))

  } catch (err) {
    console.error('[availability] Unhandled error:', err)
    return vapiSuccess(toolCallId, JSON.stringify({
      available: true,
      message: 'Could not verify — proceed with booking.',
    }))
  }
}