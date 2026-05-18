import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { resolveClinic } from '@/lib/clinic'
import { sendSMS } from '@/lib/twilio'
import { vapiSuccess, vapiError, extractToolCall } from '@/lib/vapi'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = 'unknown'

  try {
    const body = await req.json() as Record<string, unknown>
    const tool = extractToolCall(body)

    if (!tool) {
      return NextResponse.json({
        results: [{ toolCallId: 'unknown', result: 'Could not process outcome.' }]
      })
    }

    toolCallId = tool.toolCallId

    const { outcome, slotId } = tool.args as {
      outcome: string
      slotId: string
    }

    if (!outcome || !slotId) {
      return vapiError(toolCallId, 'Missing outcome or slotId.')
    }

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber)
    if (!clinic) {
      return vapiError(toolCallId, 'Could not resolve clinic.')
    }

    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || ''
    const now         = new Date().toISOString()

    // ── PATIENT SAID YES ──────────────────────────────────────────
    if (outcome === 'yes') {

      // Atomically claim the slot — prevents double booking
      const { data: claimed } = await supabase
        .from('cancelled_slots')
        .update({ status: 'processing', processing_at: now })
        .eq('id', slotId)
        .eq('status', 'open') // only claim if still open
        .select()
        .single()

      if (!claimed) {
        // Slot was just taken by another patient
        console.log(`[waitlist-outcome] Slot ${slotId} already taken`)
        return vapiSuccess(
          toolCallId,
          'slot_taken'
        )
      }

      // Get queue job for this slot to find patient details
      const { data: queueJob } = await supabase
        .from('waitlist_call_queue')
        .select('*')
        .eq('slot_id', slotId)
        .eq('status', 'calling')
        .single()

      if (!queueJob) {
        // Release the slot if we cannot find the queue job
        await supabase
          .from('cancelled_slots')
          .update({ status: 'open', processing_at: null })
          .eq('id', slotId)

        return vapiError(toolCallId, 'Could not find queue job.')
      }

      // Create the booking
      const { error: bookingError } = await supabase
        .from('bookings')
        .insert({
          clinic_id:    clinic.id,
          patient_name: queueJob.patient_name,
          phone:        queueJob.phone,
          service:      queueJob.service,
          date:         queueJob.slot_date,
          time:         queueJob.slot_time,
          status:       'Confirmed',
          booked_by:    'waitlist',
          created_at:   now,
          updated_at:   now,
        })

      if (bookingError) {
        console.error('[waitlist-outcome] Booking error:', bookingError.message)
        // Release slot on booking failure
        await supabase
          .from('cancelled_slots')
          .update({ status: 'open', processing_at: null })
          .eq('id', slotId)
        return vapiError(toolCallId, 'Could not create booking.')
      }

      // Mark slot as filled
      const slotDate    = new Date(`${queueJob.slot_date}T12:00:00`)
      const fillMinutes = Math.round((Date.now() - new Date(claimed.cancelled_at).getTime()) / (1000 * 60))

      await supabase
        .from('cancelled_slots')
        .update({
          status:           'filled',
          filled_at:        now,
          filled_in_minutes: fillMinutes,
          filled_by_waitlist_id: queueJob.waitlist_id,
        })
        .eq('id', slotId)

      // Mark waitlist entry as booked
      await supabase
        .from('waitlist')
        .update({
          status:             'booked',
          booked_at:          now,
          matched_booking_id: null,
        })
        .eq('id', queueJob.waitlist_id)

      // Mark queue job as booked
      await supabase
        .from('waitlist_call_queue')
        .update({ status: 'booked', outcome: 'booked' })
        .eq('id', queueJob.id)

      // Expire all other pending/calling queue jobs for this slot
      await supabase
        .from('waitlist_call_queue')
        .update({ status: 'expired', outcome: 'slot_filled_by_other' })
        .eq('slot_id', slotId)
        .in('status', ['pending', 'calling'])
        .neq('id', queueJob.id)

      // Send confirmation SMS to patient
      sendSMS(
        queueJob.phone,
        `You are all booked! ${queueJob.service} on ${queueJob.slot_date} at ${queueJob.slot_time} at ${clinic.name}. We look forward to seeing you! Questions? Call ${clinicPhone}.`
      ).catch(err => console.error('[waitlist-outcome] SMS error:', err))

      // Alert owner
      const ownerPhone = clinic.owner_phone || clinic.twilio_phone
      if (ownerPhone) {
        sendSMS(
          ownerPhone,
          `Pearly filled your ${queueJob.service} slot on ${queueJob.slot_date} at ${queueJob.slot_time} in ${fillMinutes} minutes. ${queueJob.patient_name} from the waitlist is now booked. — Pearly Desk`
        ).catch(err => console.error('[waitlist-outcome] Owner SMS error:', err))
      }

      console.log(`[waitlist-outcome] ${queueJob.patient_name} booked for ${queueJob.service} ${queueJob.slot_date} — filled in ${fillMinutes} min`)

      return vapiSuccess(toolCallId, 'booked')
    }

    // ── PATIENT SAID NO ───────────────────────────────────────────
    if (outcome === 'no') {

      // Find queue job
      const { data: queueJob } = await supabase
        .from('waitlist_call_queue')
        .select('*')
        .eq('slot_id', slotId)
        .eq('status', 'calling')
        .single()

      if (queueJob) {
        // Mark queue job as declined
        await supabase
          .from('waitlist_call_queue')
          .update({ status: 'declined', outcome: 'patient_declined' })
          .eq('id', queueJob.id)

        // Increment declined count — affects future scoring
        await supabase
          .from('waitlist')
          .update({
            status:           'waiting', // keep on waitlist for future slots
            declined_count:   supabase.rpc('increment_declined', { row_id: queueJob.waitlist_id }),
            last_declined_at: now,
            last_offered_slot_id: slotId,
          })
          .eq('id', queueJob.waitlist_id)

        console.log(`[waitlist-outcome] ${queueJob.patient_name} declined slot ${slotId}`)
      }

      return vapiSuccess(toolCallId, 'declined')
    }

    return vapiSuccess(toolCallId, 'acknowledged')

  } catch (err) {
    console.error('[waitlist-outcome] Error:', err)
    return vapiError(toolCallId, 'System error.')
  }
}