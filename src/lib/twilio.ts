// ============================================================================
// lib/twilio.ts — SMS send (retry once on transient network errors) + message
// templates. Connomi-branded, no hardcoded clinic phone/URL: callers pass the
// clinic's own values. Templates take an ISO timestamp + timezone and format
// for the patient's locale, instead of pre-split date/time strings.
// ============================================================================
import { env } from "@/config/env";
import { RETRY, BRAND } from "@/config/app";

export async function sendSMS(to: string, body: string): Promise<boolean> {
  const e = env();
  const from = e.TWILIO_PHONE_NUMBER;
  if (!from) {
    console.error("[twilio] TWILIO_PHONE_NUMBER not set");
    return false;
  }
  const attempt = async (): Promise<boolean> => {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64"),
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      },
    );
    if (!res.ok) {
      const data = (await res.json()) as { message?: string; code?: number };
      console.error("[twilio] error:", data.message, "code:", data.code);
      return false;
    }
    return true;
  };
  try {
    return await attempt();
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const transient =
      code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" ||
      (err as Error)?.message?.includes("fetch failed");
    if (transient) {
      await new Promise((r) => setTimeout(r, RETRY.smsTransientDelayMs));
      try { return await attempt(); } catch { return false; }
    }
    console.error("[twilio] exception:", err);
    return false;
  }
}

// ---- timestamp formatting (clinic-local) ----
function whenStr(iso: string, timezone: string): string {
  const dt = new Date(iso);
  const date = dt.toLocaleDateString("en-CA", {
    weekday: "short", month: "short", day: "numeric", timeZone: timezone,
  });
  const time = dt.toLocaleTimeString("en-CA", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone,
  });
  return `${date} at ${time}`;
}

// ---- templates (agentName + clinic values passed in; nothing hardcoded) ----
export function smsConfirmation(p: {
  name: string; service: string; startsAt: string; timezone: string;
  clinicName: string; clinicPhone: string; isNewPatient: boolean;
}): string {
  const when = whenStr(p.startsAt, p.timezone);
  if (p.isNewPatient) {
    return `Hi ${p.name}! Your ${p.service} at ${p.clinicName} is confirmed for ${when}.
Since it's your first visit, please bring photo ID, your insurance card, and a list of medications, and arrive 10 minutes early.
Reply CONFIRM to confirm or CANCEL to cancel. Questions? Call ${p.clinicPhone}.`;
  }
  return `Hi ${p.name}, your ${p.service} at ${p.clinicName} is confirmed for ${when}.
Reply CONFIRM to confirm or CANCEL to cancel. Call ${p.clinicPhone} for help.`;
}

export function smsCancellation(p: {
  name: string; service: string; startsAt: string; timezone: string;
  clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, your ${p.service} on ${whenStr(p.startsAt, p.timezone)} at ${p.clinicName} has been cancelled.
Call ${p.clinicPhone} to rebook or reply WAITLIST to be notified of openings.`;
}

export function smsReschedule(p: {
  name: string; service: string; startsAt: string; timezone: string;
  clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, your ${p.service} at ${p.clinicName} is now ${whenStr(p.startsAt, p.timezone)}.
Reply CONFIRM to confirm or CANCEL to cancel. Questions? Call ${p.clinicPhone}.`;
}

export function smsOwnerWaitlistFilled(p: {
  service: string; startsAt: string; timezone: string; patientName: string;
}): string {
  return `${BRAND.product} filled your ${p.service} slot on ${whenStr(p.startsAt, p.timezone)}. ${p.patientName} from the waitlist is now booked.`;
}

export function smsUrgentToOwner(p: {
  patientName: string; phone: string; message: string; urgency: "urgent" | "emergency";
}): string {
  const mark = p.urgency === "emergency" ? "EMERGENCY" : "URGENT";
  return `[${mark}] Message from ${p.patientName} (${p.phone}): ${p.message}. Please follow up.`;
}

export function smsReview(p: {
  name: string; clinicName: string; reviewLink: string;
}): string {
  return `Hi ${p.name}, thanks for visiting ${p.clinicName}! If you have 30 seconds, we'd love a quick review: ${p.reviewLink}`;
}

export function smsRecallFollowUp(p: {
  name: string; clinicName: string; clinicPhone: string; step: number;
}): string {
  return `Hi ${p.name}, it's time for your check-up at ${p.clinicName}. We tried to reach you — call ${p.clinicPhone} or reply YES to book. Reply STOP to opt out.`;
}

export function smsRecallFinal(p: {
  name: string; clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, this is our last reminder that you're due for a visit at ${p.clinicName}. Call ${p.clinicPhone} whenever you're ready. Reply STOP to opt out.`;
}

export function smsWaitlistBooked(p: {
  service: string; startsAt: string; timezone: string; clinicName: string; clinicPhone: string;
}): string {
  return `You're booked! ${p.service} on ${whenStr(p.startsAt, p.timezone)} at ${p.clinicName}. See you then. Questions? Call ${p.clinicPhone}.`;
}

export function smsReminder(p: {
  name: string; service: string; startsAt: string; timezone: string;
  clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, a reminder of your ${p.service} at ${p.clinicName} ${whenStr(p.startsAt, p.timezone)}.
Reply CONFIRM to confirm or CANCEL if you can't make it. Call ${p.clinicPhone} for help.`;
}

export function smsNoShow(p: {
  name: string; service: string; clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, we missed you at ${p.clinicName} today for your ${p.service}. Hope everything's okay! Call ${p.clinicPhone} to rebook whenever you're ready.`;
}

export function smsFollowupLight(p: {
  name: string; service: string; clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, hope you're feeling great after your ${p.service} at ${p.clinicName}! Any questions, just call ${p.clinicPhone}. We're here for you.`;
}

export function smsReappointment(p: {
  name: string; clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, great seeing you at ${p.clinicName} yesterday! Looks like you didn't get to book your next visit — call ${p.clinicPhone} whenever you're ready.`;
}

export function smsWaitlistOffer(p: {
  name: string; service: string; startsAt: string; timezone: string;
  clinicName: string; clinicPhone: string;
}): string {
  return `Hi ${p.name}, a ${p.service} opening just came up at ${p.clinicName} on ${whenStr(p.startsAt, p.timezone)}. Want it? Call ${p.clinicPhone} or reply YES — first to respond gets it.`;
}

export function smsWelcome(ownerName: string, clinicName: string): string {
  return `Welcome to ${BRAND.product}, ${ownerName}! ${clinicName} is now live. Your AI receptionist is answering calls. Log in to your dashboard to configure hours, services, and your agent's name.`;
}
