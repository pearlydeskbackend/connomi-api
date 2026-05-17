import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { vapiSuccess, extractToolCall } from '@/lib/vapi'

type DayHours = { open: string; close: string } | null
type ClinicHours = Record<string, DayHours>

// Simple in-memory cache — 60 second TTL
const bookingCache = new Map<string, { data: any[]; expires: number }>()

async function getBookingsForDate(clinicId: string, date: string): Promise<any[]> {
  const key = `${clinicId}:${date}`
  const cached = bookingCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.data

  const { data } = await supabase
    .from('bookings')
    .select('time')
    .eq('clinic_id', clinicId)
    .eq('date', date)
    .in('status', ['Confirmed', 'Patient Confirmed', 'Checked In'])

  const result = data || []
  bookingCache.set(key, { data: result, expires: Date.now() + 60000 })
  return result
}

function parseToMinutes(time: string): number {
  // Handle both "09:30" and "9:30 AM" formats
  const ampm = time.match(/(\d+):(\d+)\s*(AM|PM)/i)
  if (ampm) {
    let hour = parseInt(ampm[1])
    const min = parseInt(ampm[2])
    const period = ampm[3].toUpperCase()
    if (period === 'PM' && hour !== 12) hour += 12
    if (period === 'AM' && hour === 12) hour = 0
    return hour * 60 + min
  }
  const plain = time.match(/(\d+):(\d+)/)
  if (plain) return parseInt(plain[1]) * 60 + parseInt(plain[2])
  return 0
}

function minutesToTime12h(minutes: number): string {
  const hour24 = Math.floor(minutes / 60)
  const min = minutes % 60
  const period = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 > 12 ? hour24 - 12 : hour24 === 0 ? 12 : hour24
  return `${hour12}:${String(min).padStart(2, '0')} ${period}`
}

function generateSlots(open: string, close: string, durationMins: number): string[] {
  const slots: string[] = []
  let current = parseToMinutes(open)
  const end = parseToMinutes(close)
  while (current + durationMins <= end) {
    slots.push(minutesToTime12h(current))
    current += durationMins
  }
  return slots
}

function getDayOfWeek(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const d = new Date(year, month - 1, day + days)
  return d.toISOString().split('T')[0]
}

function formatSlotForSpeech(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  const dayName = d.toLocaleDateString('en-CA', { weekday: 'long' })
  const monthName = d.toLocaleDateString('en-CA', { month: 'long' })
  return `${dayName} the ${day} of ${monthName} at ${time}`
}

// Default BC holidays if clinic has none configured
const DEFAULT_BC_HOLIDAYS = [
  '2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18',
  '2026-07-01', '2026-08-03', '2026-09-07', '2026-10-12',
  '2026-11-11', '2026-12-25', '2026-12-26',
  '2027-01-01', '2027-02-15', '2027-03-26', '2027-05-24',
  '2027-07-01', '2027-08-02', '2027-09-06', '2027-10-11',
  '2027-11-11', '2027-12-27', '2027-12-28',
]

// Default clinic hours if none configured in Supabase
const DEFAULT_HOURS: ClinicHours = {
  '0': null, // Sunday closed
  '1': { open: '09:30', close: '17:30' },
  '2': { open: '09:30', close: '17:30' },
  '3': { open: '09:30', close: '17:30' },
  '4': { open: '09:30', close: '17:30' },
  '5': { open: '09:30', close: '17:30' },
  '6': { open: '09:30', close: '17:30' },
}

async function findNextAvailableSlots(
  clinicId: string,
  fromDate: string,
  count: number,
  clinicHours: ClinicHours,
  holidays: string[],
  slotDuration: number,
  excludeTime?: string
): Promise<{ date: string; time: string }[]> {
  const results: { date: string; time: string }[] = []
  let checkDate = fromDate
  let daysChecked = 0

  while (results.length < count && daysChecked < 21) {
    const dayOfWeek = getDayOfWeek(checkDate)
    const hours = clinicHours[String(dayOfWeek)]

    if (hours && !holidays.includes(checkDate)) {
      const slots = generateSlots(hours.open, hours.close, slotDuration)
      const booked = await getBookingsForDate(clinicId, checkDate)
      const bookedTimes = new Set(booked.map((b: any) => b.time))

      for (const slot of slots) {
        if (results.length >= count) break
        if (slot === excludeTime && checkDate === fromDate) continue
        if (!bookedTimes.has(slot)) {
          results.push({ date: checkDate, time: slot })
        }
      }
    }

    checkDate = addDays(checkDate, 1)
    daysChecked++
  }

  return results
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: JSON.stringify({ available: true, message: 'Could not check — proceed with booking.' }) }]
      })
    }

    toolCallId = tool.toolCallId

    const { requestedDate, requestedTime } = tool.args as {
      requestedDate: string
      requestedTime: string
    }

    if (!requestedDate || !requestedTime) {
      return vapiSuccess(toolCallId, JSON.stringify({ available: true, message: 'Missing details — proceed with booking.' }))
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiSuccess(toolCallId, JSON.stringify({ available: true, message: 'Could not verify — proceed with booking.' }))
    }

    // Read hours and holidays from clinic record — falls back to defaults
    const clinicHours: ClinicHours = (clinic as any).hours || DEFAULT_HOURS
    const clinicHolidays: string[] = (clinic as any).holidays || DEFAULT_BC_HOLIDAYS
    const slotDuration: number = (clinic as any).slot_duration_minutes || 30

    // 1 — Holiday check
    if (clinicHolidays.includes(requestedDate)) {
      const alternatives = await findNextAvailableSlots(clinic.id, requestedDate, 2, clinicHours, clinicHolidays, slotDuration)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'holiday',
        alternatives,
        speechSuggestion: alternatives.length >= 2
          ? `That day is a statutory holiday so we are closed. I have got ${formatSlotForSpeech(alternatives[0].date, alternatives[0].time)}, or ${formatSlotForSpeech(alternatives[1].date, alternatives[1].time)} — which works better?`
          : `That day is a statutory holiday so we are closed. What other day works for you?`,
      }))
    }

    // 2 — Day of week check
    const dayOfWeek = getDayOfWeek(requestedDate)
    const hours = clinicHours[String(dayOfWeek)]

    if (!hours) {
      const dayName = new Date(requestedDate + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long' })
      const alternatives = await findNextAvailableSlots(clinic.id, requestedDate, 2, clinicHours, clinicHolidays, slotDuration)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'closed',
        alternatives,
        speechSuggestion: alternatives.length >= 2
          ? `We are actually closed on ${dayName}s. I have got ${formatSlotForSpeech(alternatives[0].date, alternatives[0].time)}, or ${formatSlotForSpeech(alternatives[1].date, alternatives[1].time)} — which works better?`
          : `We are closed on ${dayName}s. What other day works for you?`,
      }))
    }

    // 3 — Time within hours check
    const requestedMins = parseToMinutes(requestedTime)
    const openMins = parseToMinutes(hours.open)
    const closeMins = parseToMinutes(hours.close)

    if (requestedMins < openMins || requestedMins >= closeMins) {
      const openFormatted = minutesToTime12h(openMins)
      const closeFormatted = minutesToTime12h(closeMins)
      const alternatives = await findNextAvailableSlots(clinic.id, requestedDate, 2, clinicHours, clinicHolidays, slotDuration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'outside_hours',
        alternatives,
        speechSuggestion: alternatives.length >= 2
          ? `That time is outside our hours — we are open ${openFormatted} to ${closeFormatted}. I have got ${formatSlotForSpeech(alternatives[0].date, alternatives[0].time)}, or ${formatSlotForSpeech(alternatives[1].date, alternatives[1].time)} — which works better?`
          : `That time is outside our hours — we are open ${openFormatted} to ${closeFormatted}. What time works for you?`,
      }))
    }

    // 4 — Already booked check
    const bookings = await getBookingsForDate(clinic.id, requestedDate)
    const bookedTimes = new Set(bookings.map((b: any) => b.time))

    if (bookedTimes.has(requestedTime)) {
      const alternatives = await findNextAvailableSlots(clinic.id, requestedDate, 2, clinicHours, clinicHolidays, slotDuration, requestedTime)
      return vapiSuccess(toolCallId, JSON.stringify({
        available: false,
        reason: 'booked',
        alternatives,
        speechSuggestion: alternatives.length >= 2
          ? `That slot is taken. I have got ${formatSlotForSpeech(alternatives[0].date, alternatives[0].time)}, or ${formatSlotForSpeech(alternatives[1].date, alternatives[1].time)} — which works better?`
          : `That slot is taken. What other time works for you?`,
      }))
    }

    // 5 — Available
    return vapiSuccess(toolCallId, JSON.stringify({
      available: true,
      date: requestedDate,
      time: requestedTime,
      speechSuggestion: `That works — so ${formatSlotForSpeech(requestedDate, requestedTime)}. Does that sound right?`,
    }))

  } catch (err) {
    console.error('[availability] Error:', err)
    return vapiSuccess(toolCallId, JSON.stringify({
      available: true,
      message: 'Could not verify availability — proceed with booking.',
    }))
  }
}