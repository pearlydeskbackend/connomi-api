export async function sendSMS(to: string, body: string): Promise<boolean> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken  = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    console.error('[twilio] Missing env vars')
    return false
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
        body: new URLSearchParams({ From: fromNumber, To: to, Body: body }).toString(),
      }
    )
    if (!response.ok) {
      const data = await response.json() as { message?: string }
      console.error('[twilio] Error:', data.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[twilio] Exception:', err)
    return false
  }
}

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

Questions? Reply to this message or call ${clinicPhone}.
— ${clinicName}`
  }

  return `Hi ${name}, your ${service} at ${clinicName} is confirmed for ${date} at ${time}. Reply CANCEL to cancel or call ${clinicPhone}.`
}

export function smsCancellation(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, your ${service} on ${date} at ${time} at ${clinicName} has been cancelled. Call ${clinicPhone} to rebook anytime.`
}

export function smsReschedule(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, your ${service} at ${clinicName} has been rescheduled to ${date} at ${time}. Questions? Call ${clinicPhone}.`
}

export function smsReminder(
  name: string,
  service: string,
  date: string,
  time: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, reminder: you have a ${service} at ${clinicName} tomorrow ${date} at ${time}. Reply CONFIRM or call ${clinicPhone}.`
}

export function smsRecall(
  name: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, it has been 6 months since your last cleaning at ${clinicName}. Call ${clinicPhone} to book or reply YES.`
}

export function smsReview(
  name: string,
  clinicName: string,
  reviewLink: string
): string {
  return `Hi ${name}, thank you for visiting ${clinicName}! Please leave us a quick review: ${reviewLink} — it only takes 30 seconds!`
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
  return `Hi ${name}, a slot just opened at ${clinicName} — ${service} on ${date} at ${time}. Reply YES to grab it or call ${clinicPhone}.`
}

export function smsFollowup(
  name: string,
  treatment: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, Dr. Do wanted to follow up on your recent ${treatment} at ${clinicName}. How are you feeling? Call us at ${clinicPhone} if you have any concerns.`
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
    return `Hi ${name}, we tried calling you from ${clinicName} about your overdue cleaning. Give us a call at ${clinicPhone} or reply YES to book — we would love to see you soon!`
  }
  return `Hi ${name}, last reminder from ${clinicName} — it has been over 6 months since your last cleaning. Call ${clinicPhone} to book or reply YES. Reply STOP to opt out.`
}

export function smsRecallFinal(
  name: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, we miss you at ${clinicName}! It has been a while since your last cleaning. When you are ready, call us at ${clinicPhone} — we are always happy to see you. Reply STOP to opt out.`
}

export function smsFollowupLight(
  name: string,
  service: string,
  clinicName: string,
  clinicPhone: string
): string {
  return `Hi ${name}, hope you are feeling great after your ${service} at ${clinicName}! Any questions or concerns? Call us at ${clinicPhone} — Dr. Do and the team are always happy to help.`
}