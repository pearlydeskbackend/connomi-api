// ─── SEND SMS WITH RETRY ──────────────────────────────────────────────────────
// Retries once on network errors (ECONNRESET, TLS failures)
// These are transient Vercel → Twilio connection issues — not code bugs

export async function sendSMS(to: string, body: string): Promise<boolean> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken  = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    console.error('[twilio] Missing env vars')
    return false
  }

  const attempt = async (): Promise<boolean> => {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          Authorization:   'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
        body: new URLSearchParams({ From: fromNumber, To: to, Body: body }).toString(),
      }
    )

    if (!response.ok) {
      const data = await response.json() as { message?: string; code?: number }
      console.error('[twilio] Error:', data.message, 'code:', data.code)
      return false
    }

    return true
  }

  try {
    return await attempt()
  } catch (err: any) {
    // Retry once on transient network errors
    const isTransient = err?.cause?.code === 'ECONNRESET' ||
                        err?.cause?.code === 'ECONNREFUSED' ||
                        err?.cause?.code === 'ETIMEDOUT' ||
                        err?.message?.includes('fetch failed')

    if (isTransient) {
      console.warn('[twilio] Transient error — retrying in 1s:', err?.cause?.code || err?.message)
      await new Promise(r => setTimeout(r, 1000))
      try {
        return await attempt()
      } catch (retryErr) {
        console.error('[twilio] Retry failed:', retryErr)
        return false
      }
    }

    console.error('[twilio] Exception:', err)
    return false
  }
}

// ─── SMS TEMPLATES ────────────────────────────────────────────────────────────

export function smsConfirmation(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string,
  isNewPatient: boolean = false
): string {
  if (isNewPatient) {
    return `Hi ${name}! Your ${service} at ${clinicName} is confirmed ✓

${date} at ${time}

Since it's your first visit, please bring:
✓ Photo ID
✓ Insurance card
✓ List of current medications
✓ Arrive 10 min early for paperwork

Reply CONFIRM to confirm or CANCEL to cancel.
Questions? Call ${clinicPhone} or text HELP.
— ${clinicName}`
  }

  // Existing patient — short with command hints
  return `Hi ${name}, your ${service} at ${clinicName} is confirmed for ${date} at ${time}.

Reply CONFIRM to confirm, CANCEL to cancel, or STATUS to view your appointments.
Call ${clinicPhone} for help.`
}

export function smsCancellation(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, your ${service} on ${date} at ${time} at ${clinicName} has been cancelled.

Call ${clinicPhone} to rebook or text WAITLIST ${service} to join the waitlist.`
}

export function smsReschedule(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, your ${service} at ${clinicName} has been rescheduled to ${date} at ${time}.

Reply CONFIRM to confirm or CANCEL to cancel. Questions? Call ${clinicPhone}.`
}

export function smsReminder(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, reminder: ${service} at ${clinicName} tomorrow ${date} at ${time}.

Reply CONFIRM to confirm or CANCEL to cancel. Call ${clinicPhone} if needed.`
}

export function smsRecall(
  name: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, it has been 6 months since your last cleaning at ${clinicName}.

Call ${clinicPhone} to book or reply YES. Reply STOP to opt out.`
}

export function smsReview(
  name: string,
  clinicName: string,
  reviewLink: string
): string {
  return `Hi ${name}, thank you for visiting ${clinicName}! We hope everything went well.

Leave us a quick review (30 seconds): ${reviewLink}`
}

export function smsWelcome(
  ownerName: string,
  clinicName: string
): string {
  return `Welcome to Pearly Desk, ${ownerName}! ${clinicName} is all set up. Pearly is now answering your calls 24/7. Login at dashboard.pearlydesk.com`
}

export function smsPaymentFailed(clinicName: string): string {
  return `Your Pearly Desk payment for ${clinicName} failed. Please update your payment method at pearlydesk.com/billing.`
}

export function smsUrgentMessage(
  patientName: string,
  phone: string,
  message: string,
  urgency: string
): string {
  const emoji = urgency === 'emergency' ? '🚨' : '⚠️'
  return `${emoji} ${urgency.toUpperCase()}: Message from ${patientName} (${phone}): ${message}. Please follow up soon.`
}

export function smsSmsReply(
  clinicName: string,
  clinicPhone: string
): string {
  return `Thanks for your message. Our team at ${clinicName} will follow up shortly. Need immediate help? Call ${clinicPhone}.`
}

export function smsWaitlistOffer(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, a slot just opened at ${clinicName}!

${service} — ${date} at ${time}

Reply YES to grab it or NO to skip. Slot may fill quickly. Call ${clinicPhone} if needed.`
}

export function smsFollowup(
  name: string,
  treatment: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, following up on your recent ${treatment} at ${clinicName}. How are you feeling?

Call ${clinicPhone} if you have any concerns — we are always here to help.`
}

export function smsBriefing(
  clinicName: string,
  bookingsToday: number,
  overnightBookings: number,
  unreadMessages: number
): string {
  const parts = []
  parts.push(`Good morning — here is your ${clinicName} summary:`)
  parts.push(`📅 ${bookingsToday} appointments today`)
  if (overnightBookings > 0) {
    parts.push(`🌙 Pearly booked ${overnightBookings} appointment${overnightBookings > 1 ? 's' : ''} overnight`)
  }
  if (unreadMessages > 0) {
    parts.push(`💬 ${unreadMessages} unread message${unreadMessages > 1 ? 's' : ''} need attention`)
  }
  parts.push(`Login: dashboard.pearlydesk.com`)
  return parts.join('\n')
}

export function smsRecallFollowUp(
  name: string,
  clinicName: string,
  clinicPhone: string,
  attemptNumber: number
): string {
  if (attemptNumber === 1) {
    return `Hi ${name}, we tried calling you from ${clinicName} about your overdue cleaning.

Call ${clinicPhone} or reply YES to book. Reply STOP to opt out.`
  }
  return `Hi ${name}, last reminder from ${clinicName} — it has been over 6 months since your last cleaning.

Call ${clinicPhone} or reply YES to book. Reply STOP to opt out.`
}

export function smsRecallFinal(
  name: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, we miss you at ${clinicName}! When you are ready, call ${clinicPhone} — we are always happy to see you.

Reply STOP to opt out.`
}

export function smsFollowupLight(
  name: string,
  service: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, hope you are feeling great after your ${service} at ${clinicName}!

Any questions or concerns? Call ${clinicPhone} — we are always happy to help.`
}