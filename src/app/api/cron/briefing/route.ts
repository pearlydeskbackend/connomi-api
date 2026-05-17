import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { sendSMS } from '@/lib/twilio'

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const force = req.nextUrl.searchParams.get('force') === 'true'
    const today          = new Date().toISOString().split('T')[0]
    const twelveHoursAgo = new Date(Date.now() - 12 * 3600000).toISOString()
    const sixMonthsAgo   = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]

    const { data: clinics } = await supabase
      .from('clinics').select('id, name, owner_phone').eq('active', true)

    if (!clinics?.length) return NextResponse.json({ success: true })

    for (const clinic of clinics) {
      if (!clinic.owner_phone) continue

      const { data: todayBookings } = await supabase
        .from('bookings').select('time, status')
        .eq('clinic_id', clinic.id).eq('date', today).neq('status', 'Cancelled')

      const { data: pearlyOvernight } = await supabase
        .from('bookings').select('id')
        .eq('clinic_id', clinic.id)
        .in('booked_by', ['pearly', 'vapi'])
        .gte('created_at', twelveHoursAgo)

      const { data: recallDue } = await supabase
        .from('patients').select('id')
        .eq('clinic_id', clinic.id)
        .lt('last_cleaning_date', sixMonthsAgo)
        .lt('recall_attempts', 3)

      const { data: unreadMessages } = await supabase
        .from('messages').select('id')
        .eq('clinic_id', clinic.id).eq('status', 'unread')

      const pearlyCount  = pearlyOvernight?.length || 0
      const todayCount   = todayBookings?.length || 0
      const recallCount  = recallDue?.length || 0
      const messageCount = unreadMessages?.length || 0
      const bookedTimes  = (todayBookings || []).map(b => b.time)
      const peakSlots    = ['9:00 AM', '10:00 AM', '11:00 AM', '2:00 PM', '3:00 PM']
      const emptySlots   = peakSlots.filter(s => !bookedTimes.includes(s))

      const lines = [`Good morning, ${clinic.name} ☀️`, '']
      if (pearlyCount > 0) lines.push(`Pearly booked ${pearlyCount} appointment${pearlyCount !== 1 ? 's' : ''} while you slept.`)
      else lines.push('No new bookings overnight.')
      lines.push(`Today you have ${todayCount} patient${todayCount !== 1 ? 's' : ''} scheduled.`)
      if (emptySlots.length > 0) lines.push(`Open slots: ${emptySlots.slice(0, 3).join(', ')}.`)
      if (recallCount > 0) lines.push(`${recallCount} patient${recallCount !== 1 ? 's are' : ' is'} overdue for their 6-month cleaning.`)
      if (messageCount > 0) lines.push(`${messageCount} unread message${messageCount !== 1 ? 's' : ''} in your inbox.`)
      lines.push('', 'Have a great day. — Pearly Desk')

      await sendSMS(clinic.owner_phone, lines.join('\n'))
      await new Promise(r => setTimeout(r, 500))
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[briefing] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
