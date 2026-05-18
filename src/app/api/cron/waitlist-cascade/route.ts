import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { triggerVapiCall } from '@/lib/vapi'
import { sendSMS, smsWaitlistOffer } from '@/lib/twilio'
import { startCronLog, completeCronLog, failCronLog } from '@/lib/cron'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret  = req.headers.get('x-cron-secret')
  const vercelCron  = req.headers.get('x-vercel-cron')
  console.log('[cascade] Auth headers — x-cron-secret:', cronSecret ? 'present' : 'missing', 'x-vercel-cron:', vercelCron)
  
  export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret  = req.headers.get('x-cron-secret')
  const vercelCron  = req.headers.get('x-vercel-cron')
  console.log('[cascade] Auth headers — x-cron-secret:', cronSecret ? 'present' : 'missing', 'x-vercel-cron:', vercelCron)
  
  const authorized = cronSecret === process.env.CRON_SECRET || vercelCron === '1'
  if (!authorized) {
    console.log('[cascade] Unauthorized — vercelCron value:', JSON.stringify(vercelCron))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const force = req.nextUrl.searchParams.get('force') === 'true'
  const logId = await startCronLog('waitlist-cascade')

  try {
    const now = new Date().toISOString()

    // Get all pending queue jobs that are due
    // Only jobs where slot is still open
    const { data: jobs, error } = await supabase
      .from('waitlist_call_queue')
      .select(`
        *,
        cancelled_slots!slot_id(status, slot_date, slot_time, service),
        clinics!clinic_id(name, owner_phone, twilio_phone)
      `)
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('queue_position', { ascending: true })
      .limit(20)

    if (error) {
      await failCronLog(logId, error.message)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!jobs?.length) {
      console.log('[cascade] No pending queue jobs')
      await completeCronLog(logId, { processed: 0, called: 0, sms: 0, skipped: 0 })
      return NextResponse.json({ success: true, processed: 0 })
    }

    console.log(`[cascade] ${jobs.length} queue jobs due`)

    const assistantId   = process.env.VAPI_WAITLIST_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    let called  = 0
    let sms     = 0
    let skipped = 0

    for (const job of jobs) {
      const slotInfo = (job as any).cancelled_slots
      const clinic   = (job as any).clinics

      // Skip if slot is no longer open
      if (!slotInfo || slotInfo.status !== 'open') {
        console.log(`[cascade] Slot ${job.slot_id} no longer open — expiring job`)
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'expired', outcome: 'slot_not_open' })
          .eq('id', job.id)
        skipped++
        continue
      }

      // Skip if slot has passed
      const slotDate = new Date(`${job.slot_date}T12:00:00`)
      if (slotDate < new Date()) {
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'expired', outcome: 'slot_passed' })
          .eq('id', job.id)
          .eq('slot_id', job.slot_id)
        await supabase
          .from('cancelled_slots')
          .update({ status: 'expired' })
          .eq('id', job.slot_id)
        skipped++
        continue
      }

      // Check waitlist entry still valid
      const { data: waitlistEntry } = await supabase
        .from('waitlist')
        .select('status')
        .eq('id', job.waitlist_id)
        .single()

      if (!waitlistEntry || !['waiting'].includes(waitlistEntry.status)) {
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'skipped', outcome: 'patient_unavailable' })
          .eq('id', job.id)
        skipped++
        continue
      }

      const clinicPhone = clinic?.twilio_phone || clinic?.owner_phone || ''
      const clinicName  = clinic?.name || 'the clinic'

      console.log(`[cascade] Processing position ${job.queue_position} — ${job.patient_name}`)

      // Claim the job atomically
      const { data: claimed } = await supabase
        .from('waitlist_call_queue')
        .update({ status: 'calling', attempted_at: now })
        .eq('id', job.id)
        .eq('status', 'pending')
        .select()
        .single()

      if (!claimed) {
        skipped++
        continue
      }

      // Mark waitlist as called
      await supabase
        .from('waitlist')
        .update({ status: 'called', last_attempt_at: now })
        .eq('id', job.waitlist_id)
        .eq('status', 'waiting')

      let success = false

      if (job.method === 'sms') {
        success = await sendSMS(
          job.phone,
          smsWaitlistOffer(
            job.patient_name, job.service,
            job.slot_date, job.slot_time,
            clinicName, clinicPhone
          )
        )

        if (success) {
          sms++
          // Reset to waiting so YES reply can book
          await supabase
            .from('waitlist')
            .update({ status: 'waiting' })
            .eq('id', job.waitlist_id)
          await supabase
            .from('waitlist_call_queue')
            .update({ status: 'called', outcome: 'sms_sent' })
            .eq('id', job.id)
        }

      } else if (assistantId && phoneNumberId) {
        success = await triggerVapiCall({
          assistantId,
          phoneNumberId,
          customerPhone: job.phone,
          customerName:  job.patient_name,
          variables: {
            patientName:   job.patient_name,
            availableDate: job.slot_date,
            availableTime: job.slot_time,
            service:       job.service,
            slotId:        job.slot_id,
            clinicName,
            clinicPhone,
          },
        })

        if (success) {
          called++
          await supabase
            .from('waitlist_call_queue')
            .update({ status: 'called', outcome: 'call_initiated' })
            .eq('id', job.id)
        }
      }

      if (!success) {
        // Contact failed — skip this candidate
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'skipped', outcome: 'contact_failed' })
          .eq('id', job.id)
        await supabase
          .from('waitlist')
          .update({ status: 'waiting' })
          .eq('id', job.waitlist_id)
        skipped++
      }

      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`[cascade] Done — called: ${called}, sms: ${sms}, skipped: ${skipped}`)

    const result = { processed: jobs.length, called, sms, skipped }
    await completeCronLog(logId, result)
    return NextResponse.json({ success: true, ...result })

  } catch (err) {
    console.error('[cascade] Error:', err)
    await failCronLog(logId, String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}