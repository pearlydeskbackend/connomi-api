import { supabase } from '@/lib/supabase'

// ─── CRON EXECUTION LOGGING ───────────────────────────────────────────────────

export async function startCronLog(cronName: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('cron_logs')
      .insert({
        cron_name:  cronName,
        started_at: new Date().toISOString(),
        status:     'running',
      })
      .select()
      .single()
    return data?.id || null
  } catch {
    return null
  }
}

export async function completeCronLog(
  logId: string | null,
  result: Record<string, unknown>
): Promise<void> {
  if (!logId) return
  try {
    await supabase
      .from('cron_logs')
      .update({
        status:       'success',
        completed_at: new Date().toISOString(),
        result,
      })
      .eq('id', logId)
  } catch {}
}

export async function failCronLog(
  logId: string | null,
  error: string
): Promise<void> {
  if (!logId) return
  try {
    await supabase
      .from('cron_logs')
      .update({
        status:       'failed',
        completed_at: new Date().toISOString(),
        error,
      })
      .eq('id', logId)
  } catch {}
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

export async function wasContactedRecently(
  clinicId: string,
  phone: string,
  withinHours = 24
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('patients')
      .select('last_contacted_at')
      .eq('clinic_id', clinicId)
      .eq('phone', phone)
      .single()

    if (!data?.last_contacted_at) return false

    const hoursSince =
      (Date.now() - new Date(data.last_contacted_at).getTime()) / (1000 * 60 * 60)

    return hoursSince < withinHours
  } catch {
    return false
  }
}

export async function markContacted(
  clinicId: string,
  phone: string
): Promise<void> {
  try {
    await supabase
      .from('patients')
      .upsert(
        {
          clinic_id:          clinicId,
          phone,
          last_contacted_at:  new Date().toISOString(),
          updated_at:         new Date().toISOString(),
        },
        { onConflict: 'clinic_id,phone' }
      )
  } catch {}
}

// ─── IDEMPOTENCY LOCK ─────────────────────────────────────────────────────────

export async function claimBooking(
  bookingId: string,
  field: string
): Promise<boolean> {
  try {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('bookings')
      .update({ [field]: now, updated_at: now })
      .eq('id', bookingId)
      .is(field, null)
      .select()
      .single()
    return !!data
  } catch {
    return false
  }
}

// ─── TIMEZONE ─────────────────────────────────────────────────────────────────

export function isWithinCallingHoursForClinic(
  timezone: string,
  force = false
): boolean {
  if (force) return true
  try {
    const now  = new Date()
    const time = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
    const hour = time.getHours()
    const day  = time.getDay()
    if (day === 0) return false
    if (day >= 1 && day <= 5) return hour >= 9 && hour < 20
    if (day === 6) return hour >= 10 && hour < 17
    return false
  } catch {
    return false
  }
}

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────

export async function softDelete(
  table: 'bookings' | 'patients' | 'waitlist',
  id: string
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from(table)
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single()
    return !!data
  } catch {
    return false
  }
}

// ─── WAITLIST EXPIRY ──────────────────────────────────────────────────────────

export async function expireWaitlistEntries(clinicId: string): Promise<number> {
  try {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('waitlist')
      .update({ status: 'expired', updated_at: now })
      .eq('clinic_id', clinicId)
      .eq('status', 'waiting')
      .lt('expires_at', now)
      .select()
    return data?.length || 0
  } catch {
    return 0
  }
}