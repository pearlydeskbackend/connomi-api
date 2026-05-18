import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS } from '@/lib/twilio'
import { isWithinCallingHours, nextCallingWindow } from '@/lib/schedule'
import {
  startCronLog,
  completeCronLog,
  failCronLog,
  expireWaitlistEntries,
} from '@/lib/cron'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  if (!isWithinCallingHours(force)) {
    return NextResponse.json({ success: true, skipped: true, reason: nextCallingWindow() })
  }

  const logId = await startCronLog('waitlist')

  try {
    const now            = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    const appUrl         = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'

    // 1 — Expire old waitlist entries using shared helper
    // This uses the expireWaitlistEntries helper per clinic
    const { data: activeClinics } = await supabase
      .from('clinics')
      .select('id, name')
      .eq('active', true)

    let totalExpired = 0
    for (const clinic of (activeClinics || [])) {
      const expired = await expireWaitlistEntries(clinic.id)
      if (expired > 0) {
        console.log(`[waitlist-cron] Expired ${expired} waitlist entries for ${clinic.name}`)
        totalExpired += expired
      }
    }

    // 2 — Reset stale 'called' entries so they can be retried
    const { data: stale } = await supabase
      .from('waitlist')
      .select('id, attempt_count')
      .eq('status', 'called')
      .lt('last_attempt_at', fiveMinutesAgo)
      .lt('attempt_count', 3)

    for (const entry of (stale || [])) {
      await supabase
        .from('waitlist')
        .update({ status: 'waiting' })
        .eq('id', entry.id)
    }

    if (stale?.length) {
      console.log(`[waitlist-cron] Reset ${stale.length} stale entries back to waiting`)
    }

    // 3 — Expire slots that have already passed, notify owner if unfilled
    const { data: passedSlots } = await supabase
      .from('cancelled_slots')
      .select('*, clinics(name, owner_phone, twilio_phone)')
      .eq('status', 'open')
      .lt('slot_date', now.toISOString().split('T')[0])

    for (const slot of (passedSlots || [])) {
      await supabase
        .from('cancelled_slots')
        .update({ status: 'expired' })
        .eq('id', slot.id)

      const clinic     = slot.clinics as any
      const ownerPhone = clinic?.owner_phone || clinic?.twilio_phone

      // Only notify owner if Pearly actually tried to fill it
      if (ownerPhone && slot.fill_attempts > 0) {
        sendSMS(
          ownerPhone,
          `Heads up — the ${slot.service} slot on ${slot.slot_date} at ${slot.slot_time} went unfilled. Pearly tried ${slot.fill_attempts} waitlist call${slot.fill_attempts > 1 ? 's' : ''} but no one was available. — Pearly Desk`
        ).catch(console.error)
      }
    }

    if (passedSlots?.length) {
      console.log(`[waitlist-cron] Expired ${passedSlots.length} passed slots`)
    }

    // 4 — Find all open slots and retry filling them
    const { data: openSlots } = await supabase
      .from('cancelled_slots')
      .select('id, slot_date, slot_time, fill_attempts')
      .eq('status', 'open')
      .gte('slot_date', now.toISOString().split('T')[0])
      .lt('fill_attempts', 10)
      .order('slot_date', { ascending: true })

    let triggered = 0

    for (const slot of (openSlots || [])) {
      // Only fill if more than 2 hours away
      const slotDateTime = new Date(`${slot.slot_date}T12:00:00`)
      const hoursAway    = (slotDateTime.getTime() - now.getTime()) / (1000 * 60 * 60)
      if (hoursAway < 2) continue

      fetch(`${appUrl}/api/internal/fill-slot`, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-internal-secret': process.env.CRON_SECRET || '',
        },
        body: JSON.stringify({ slotId: slot.id }),
      }).catch(err => console.error('[waitlist-cron] Fill trigger error:', err))

      triggered++
      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`[waitlist-cron] Done — expired: ${totalExpired}, stale reset: ${stale?.length || 0}, expired slots: ${passedSlots?.length || 0}, fills triggered: ${triggered}`)

    const result = {
      expired:        totalExpired,
      staleReset:     stale?.length || 0,
      expiredSlots:   passedSlots?.length || 0,
      fillsTriggered: triggered,
    }

    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[waitlist-cron] Error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}