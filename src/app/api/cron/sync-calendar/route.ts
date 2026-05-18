import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { parseICal, dateToSlotTime, dateToSlotDate } from '@/lib/ical'
import { startCronLog, completeCronLog, failCronLog } from '@/lib/cron'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const logId = await startCronLog('sync-calendar')

  try {
    // Get all clinics with iCal sync enabled
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, ical_url, timezone')
      .eq('active', true)
      .eq('ical_sync_enabled', true)
      .not('ical_url', 'is', null)

    if (error) {
      await failCronLog(logId, error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!clinics?.length) {
      await completeCronLog(logId, { synced: 0, total: 0 })
      return NextResponse.json({ success: true, synced: 0, message: 'No clinics with iCal enabled' })
    }

    console.log(`[sync-calendar] Syncing ${clinics.length} clinics`)

    let synced  = 0
    let failed  = 0
    let total   = 0

    for (const clinic of clinics) {
      try {
        const timezone = (clinic as any).timezone || 'America/Vancouver'
        const result   = await syncClinicCalendar(clinic.id, clinic.name, clinic.ical_url!, timezone)

        total  += result.eventsFound
        synced += result.eventsSynced

        // Update last synced timestamp
        await supabase
          .from('clinics')
          .update({ ical_last_synced_at: new Date().toISOString() })
          .eq('id', clinic.id)

        console.log(`[sync-calendar] ${clinic.name} — found: ${result.eventsFound}, synced: ${result.eventsSynced}`)

      } catch (err) {
        console.error(`[sync-calendar] Failed for ${clinic.name}:`, err)
        failed++
      }
    }

    console.log(`[sync-calendar] Done — total events: ${total}, synced: ${synced}, failed clinics: ${failed}`)

    const result = { total, synced, failed, clinics: clinics.length }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[sync-calendar] Error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

async function syncClinicCalendar(
  clinicId: string,
  clinicName: string,
  icalUrl: string,
  timezone: string
): Promise<{ eventsFound: number; eventsSynced: number }> {

  // Fetch the iCal feed
  const response = await fetch(icalUrl, {
    headers: {
      'User-Agent':     'PearlyDesk/1.0 Calendar Sync',
      'Cache-Control':  'no-cache, no-store',
      'Pragma':         'no-cache',
    },
    cache:  'no-store',
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    throw new Error(`iCal fetch failed: ${response.status} ${response.statusText}`)
  }

  const rawICal = await response.text()
  if (!rawICal.includes('BEGIN:VCALENDAR')) {
    throw new Error('Invalid iCal format — missing BEGIN:VCALENDAR')
  }

  // Parse events
  const events = parseICal(rawICal)
  console.log(`[sync-calendar] ${clinicName} — parsed ${events.length} events`)

  if (!events.length) {
    return { eventsFound: 0, eventsSynced: 0 }
  }

  // Only sync events in the next 90 days — no point syncing the past
  const now       = new Date()
  const maxDate   = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  const upcoming  = events.filter(e => e.startAt >= now && e.startAt <= maxDate)

  // Delete old PMS bookings for this clinic beyond 1 day ago
  // This handles cancellations — if event disappears from feed it gets deleted
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  await supabase
    .from('pms_bookings')
    .delete()
    .eq('clinic_id', clinicId)
    .gte('start_at', oneDayAgo.toISOString())

  if (!upcoming.length) {
    return { eventsFound: events.length, eventsSynced: 0 }
  }

  // Upsert all upcoming events
  const rows = upcoming.map(event => ({
    clinic_id: clinicId,
    pms_uid:   event.uid,
    title:     event.summary,
    provider:  event.provider || null,
    start_at:  event.startAt.toISOString(),
    end_at:    event.endAt.toISOString(),
    slot_date: dateToSlotDate(event.startAt, timezone),
    slot_time: dateToSlotTime(event.startAt, timezone),
    status:    event.status,
    raw_ical:  event.raw,
    updated_at: new Date().toISOString(),
  }))

  // Upsert in batches of 50
  let synced = 0
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50)
    const { error } = await supabase
      .from('pms_bookings')
      .upsert(batch, { onConflict: 'clinic_id,pms_uid' })

    if (error) {
      console.error(`[sync-calendar] Upsert error batch ${i}:`, error.message)
    } else {
      synced += batch.length
    }
  }

  return { eventsFound: events.length, eventsSynced: synced }
}