export interface ICalEvent {
  uid:       string
  summary:   string
  startAt:   Date
  endAt:     Date
  status:    string
  provider:  string
  raw:       string
}

export function parseICal(raw: string): ICalEvent[] {
  const events: ICalEvent[] = []
  const lines = raw
    .replace(/\r\n /g, '')
    .replace(/\r\n\t/g, '')
    .split(/\r\n|\n|\r/)

  let inEvent      = false
  let currentEvent: Record<string, string> = {}
  let rawBlock     = ''

  console.log('[ical] parseICal — total lines:', lines.length)

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent      = true
      currentEvent = {}
      rawBlock     = line + '\n'
      console.log('[ical] Found BEGIN:VEVENT')
      continue
    }

    if (line === 'END:VEVENT') {
      rawBlock += line + '\n'
      console.log('[ical] Found END:VEVENT — props:', JSON.stringify(currentEvent))
      const event = buildEvent(currentEvent, rawBlock)
      if (event) {
        events.push(event)
        console.log('[ical] Event built successfully:', event.uid)
      } else {
        console.log('[ical] Event build returned null')
      }
      inEvent      = false
      currentEvent = {}
      rawBlock     = ''
      continue
    }

    if (inEvent) {
      rawBlock += line + '\n'
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const keyPart = line.substring(0, colonIdx)
      const value   = line.substring(colonIdx + 1)
      const key     = keyPart.split(';')[0].toUpperCase()
      const params  = keyPart.includes(';') ? keyPart.substring(keyPart.indexOf(';') + 1) : ''
      currentEvent[key]           = value
      currentEvent[`${key}_FULL`] = `${params}:${value}`
    }
  }

  console.log('[ical] parseICal done — events found:', events.length)
  return events
}

function buildEvent(props: Record<string, string>, raw: string): ICalEvent | null {
  const uid     = props['UID']
  const summary = props['SUMMARY'] || 'Appointment'
  const status  = (props['STATUS'] || 'CONFIRMED').toLowerCase()

  console.log('[ical] buildEvent — uid:', uid, 'status:', status, 'DTSTART:', props['DTSTART'])

  if (!uid) {
    console.log('[ical] buildEvent — no uid, returning null')
    return null
  }
  if (status === 'cancelled' || status === 'free') {
    console.log('[ical] buildEvent — cancelled or free, returning null')
    return null
  }

  const startAt = parseICalDate(props['DTSTART'] || '', props['DTSTART_FULL'] || '')
  const endAt   = parseICalDate(props['DTEND'] || '', props['DTEND_FULL'] || '')

  console.log('[ical] buildEvent — startAt:', startAt, 'endAt:', endAt)

  if (!startAt || !endAt) {
    console.log('[ical] buildEvent — invalid dates, returning null')
    return null
  }

  const organizer = props['ORGANIZER'] || ''
  const provider  = organizer.replace(/^.*CN=/i, '').replace(/;.*$/, '').trim() || ''

  return { uid, summary, startAt, endAt, status, provider, raw }
}

function parseICalDate(value: string, fullParam: string): Date | null {
  if (!value) return null

  console.log('[ical] parseICalDate — value:', value, 'fullParam:', fullParam)

  try {
    // All day: YYYYMMDD
    if (/^\d{8}$/.test(value)) {
      const y = parseInt(value.substring(0, 4))
      const m = parseInt(value.substring(4, 6)) - 1
      const d = parseInt(value.substring(6, 8))
      return new Date(y, m, d, 0, 0, 0)
    }

    // UTC: YYYYMMDDTHHMMSSZ
    if (value.endsWith('Z')) {
      const y  = parseInt(value.substring(0, 4))
      const mo = parseInt(value.substring(4, 6)) - 1
      const d  = parseInt(value.substring(6, 8))
      const h  = parseInt(value.substring(9, 11))
      const mi = parseInt(value.substring(11, 13))
      const s  = parseInt(value.substring(13, 15))
      const result = new Date(Date.UTC(y, mo, d, h, mi, s))
      console.log('[ical] parseICalDate UTC result:', result)
      return result
    }

    // Local with TZID: YYYYMMDDTHHMMSS
    if (/^\d{8}T\d{6}$/.test(value)) {
      const y  = parseInt(value.substring(0, 4))
      const mo = parseInt(value.substring(4, 6)) - 1
      const d  = parseInt(value.substring(6, 8))
      const h  = parseInt(value.substring(9, 11))
      const mi = parseInt(value.substring(11, 13))
      const s  = parseInt(value.substring(13, 15))

      const tzMatch  = fullParam.match(/TZID=([^:;]+)/i)
      const tz       = tzMatch?.[1] || 'America/Vancouver'
      const localStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      const result   = new Date(localToUTC(localStr, tz))
      console.log('[ical] parseICalDate local result:', result, 'tz:', tz)
      return result
    }

    console.log('[ical] parseICalDate — no pattern matched for:', value)
    return null
  } catch (err) {
    console.error('[ical] parseICalDate error:', err)
    return null
  }
}

function localToUTC(localStr: string, timezone: string): number {
  try {
    const testDate  = new Date(localStr + 'Z')
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
      hour:     '2-digit',
      minute:   '2-digit',
      second:   '2-digit',
      hour12:   false,
    })
    const parts    = formatter.formatToParts(testDate)
    const tzYear   = parseInt(parts.find(p => p.type === 'year')?.value   || '0')
    const tzMonth  = parseInt(parts.find(p => p.type === 'month')?.value  || '0') - 1
    const tzDay    = parseInt(parts.find(p => p.type === 'day')?.value    || '0')
    const tzHour   = parseInt(parts.find(p => p.type === 'hour')?.value   || '0')
    const tzMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0')
    const tzSecond = parseInt(parts.find(p => p.type === 'second')?.value || '0')

    const tzDisplayMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour === 24 ? 0 : tzHour, tzMinute, tzSecond)
    const offset      = testDate.getTime() - tzDisplayMs
    return new Date(localStr).getTime() + offset
  } catch {
    const d      = new Date(localStr)
    const offset = isDST(d) ? 7 : 8
    return d.getTime() + offset * 60 * 60 * 1000
  }
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset()
  return Math.max(jan, jul) !== date.getTimezoneOffset()
}

export function dateToSlotTime(date: Date, timezone = 'America/Vancouver'): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  })
}

export function dateToSlotDate(date: Date, timezone = 'America/Vancouver'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).formatToParts(date)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}