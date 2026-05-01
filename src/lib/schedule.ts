const VANCOUVER_TZ = 'America/Vancouver'

function getVancouverTime(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: VANCOUVER_TZ }))
}

export function isWithinCallingHours(): boolean {
  const now  = getVancouverTime()
  const hour = now.getHours()
  const day  = now.getDay()

  if (day === 0) return false
  if (day >= 1 && day <= 5) return hour >= 9 && hour < 20
  if (day === 6) return hour >= 10 && hour < 17
  return false
}

export function nextCallingWindow(): string {
  const now  = getVancouverTime()
  const hour = now.getHours()
  const day  = now.getDay()

  if (day === 0) return 'Monday at 9:00 AM'
  if (day === 6 && hour >= 17) return 'Monday at 9:00 AM'
  if (day >= 1 && day <= 5 && hour >= 20) return 'tomorrow at 9:00 AM'
  if (hour < 9) return 'today at 9:00 AM'
  return 'now'
}

export const MAX_CALL_ATTEMPTS = 3