import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS } from '@/lib/twilio'
import {
  startCronLog,
  completeCronLog,
  failCronLog,
} from '@/lib/cron'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = req.nextUrl.searchParams.get('force') === 'true'
  console.log(`[briefing] Starting — force: ${force}`)

  const logId = await startCronLog('briefing')

  try {
    const today          = new Date().toISOString().split('T')[0]
    const twelveHoursAgo = new Date(Date.now() - 12 * 3600000).toISOString()
    const sixMonthsAgo   = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]

    const { data: clinics } = await supabase
      .from('clinics')
      .select('id, name, owner_phone')
      .eq('active', true)

    console.log(`[briefing] Active clinics: ${clinics?.length || 0}`)

    if (!clinics?.length) {
      await completeCronLog(logId, { sent: 0, clinics: 0 })
      return NextResponse.json({ success: true })
    }

    let sent = 0

    for (const clinic of clinics) {
      if (!clinic.owner_phone) {
        console.log(`[briefing] ${clinic.name} — no owner phone, skipping`)
        continue
      }

      console.log(`[briefing] Building summary for ${clinic.name}`)

      const { data: todayBookings } = await supabase
        .from('bookings')
        .select('time, status, patient_name, service')
        .eq('clinic_id', clinic.id)
        .eq('date', today)
        .neq('status', 'Cancelled')
        .is('deleted_at', null)

      const { data: pearlyOvernight } = await supabase
        .from('bookings')
        .select('id, patient_name, service, time')
        .eq('clinic_id', clinic.id)
        .in('booked_by', ['pearly', 'vapi'])
        .gte('created_at', twelveHoursAgo)
        .is('deleted_at', null)

      const { data: recallDue } = await supabase
        .from('patients')
        .select('id')
        .eq('clinic_id', clinic.id)
        .lt('last_cleaning_date', sixMonthsAgo)
        .in('recall_status', ['pending', 'in_progress'])
        .is('deleted_at', null)

      const { data: unreadMessages } = await supabase
        .from('messages')
        .select('id')
        .eq('clinic_id', clinic.id)
        .eq('status', 'unread')

      // Count no-shows from yesterday
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const { data: noShows } = await supabase
        .from('bookings')
        .select('id')
        .eq('clinic_id', clinic.id)
        .eq('date', yesterday.toISOString().split('T')[0])
        .not('no_show_at', 'is', null)

      const pearlyCount  = pearlyOvernight?.length || 0
      const todayCount   = todayBookings?.length || 0
      const recallCount  = recallDue?.length || 0
      const messageCount = unreadMessages?.length || 0
      const noShowCount  = noShows?.length || 0
      const bookedTimes  = (todayBookings || []).map(b => b.time)
      const peakSlots    = ['9:30 AM', '10:00 AM', '11:00 AM', '2:00 PM', '3:00 PM']
      const emptySlots   = peakSlots.filter(s => !bookedTimes.includes(s))

      console.log(`[briefing] ${clinic.name} — today: ${todayCount}, overnight: ${pearlyCount}, recall: ${recallCount}, messages: ${messageCount}, noshows: ${noShowCount}`)

      const lines = [`Good morning, ${clinic.name} ☀️`, '']

      if (pearlyCount > 0) {
        lines.push(`🌙 Pearly booked ${pearlyCount} appointment${pearlyCount !== 1 ? 's' : ''} while you slept:`)
        for (const b of pearlyOvernight || []) {
          lines.push(`   → ${b.patient_name} — ${b.service} at ${b.time}`)
        }
        lines.push('')
      } else {
        lines.push('No new bookings overnight.')
      }

      lines.push(`📅 Today: ${todayCount} patient${todayCount !== 1 ? 's' : ''} scheduled.`)

      if (emptySlots.length > 0) {
        lines.push(`🕐 Open slots: ${emptySlots.slice(0, 3).join(', ')}.`)
      }

      if (noShowCount > 0) {
        lines.push(`⚠️ ${noShowCount} no-show${noShowCount !== 1 ? 's' : ''} yesterday — Pearly followed up.`)
      }

      if (recallCount > 0) {
        lines.push(`📞 ${recallCount} patient${recallCount !== 1 ? 's are' : ' is'} overdue for their 6-month cleaning.`)
      }

      if (messageCount > 0) {
        lines.push(`💬 ${messageCount} unread message${messageCount !== 1 ? 's' : ''} in your inbox.`)
      }

      lines.push('', 'Have a great day. — Pearly Desk')
      lines.push('dashboard.pearlydesk.com')

      const message = lines.join('\n')
      console.log(`[briefing] Sending to ${clinic.owner_phone}:\n${message}`)

      const ok = await sendSMS(clinic.owner_phone, message)
      console.log(`[briefing] SMS sent: ${ok}`)
      if (ok) sent++

      await new Promise(r => setTimeout(r, 500))
    }

    console.log(`[briefing] Done — sent: ${sent}`)

    await completeCronLog(logId, { sent, clinics: clinics.length })
    return NextResponse.json({ success: true, sent })

  } catch (err) {
    console.error('[briefing] Error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}