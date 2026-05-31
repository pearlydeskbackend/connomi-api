// ============================================================================
// POST /api/twilio/webhook — inbound patient SMS command handler.
// Patients text commands: STATUS, CONFIRM, CANCEL, WAITLIST [service], REMOVE,
// YES (claim a waitlist offer), HELP. Returns empty TwiML; replies are sent via
// the SMS API. The YES path routes through book_appointment for atomic safety.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getClinicByPhone } from "@/lib/clinic";
import { normalizePhone } from "@/lib/phone";
import { sendSMS, smsWaitlistBooked, smsOwnerWaitlistFilled } from "@/lib/twilio";
import { speakableSlot } from "@/lib/speech";
import { findNextBooking } from "@/lib/lookup";
import type { BookResult } from "@/lib/booking-result";

export const dynamic = "force-dynamic";
const TWIML = '<?xml version="1.0"?><Response></Response>';
const xml = () => new NextResponse(TWIML, { headers: { "Content-Type": "text/xml" } });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const form = await req.formData();
    const from = form.get("From") as string;
    const to = form.get("To") as string;
    const rawBody = form.get("Body") as string;
    const msg = rawBody?.trim().toLowerCase() || "";
    if (!from || !to || !rawBody) return xml();

    const clinic = await getClinicByPhone(to);
    if (!clinic) return xml();

    const phone = normalizePhone(from) || from;
    const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";

    // ---- STATUS ----
    if (["status", "appointments", "appt", "booking"].includes(msg)) {
      const booking = await findNextBooking(clinic.id, phone);
      await sendSMS(from, booking
        ? `Your next appointment at ${clinic.name}: ${booking.service} on ${speakableSlot(booking.starts_at, clinic.timezone)}. Reply CANCEL to cancel.`
        : `You have no upcoming appointments at ${clinic.name}. Reply BOOK or call ${clinicPhone}.`);
      return xml();
    }

    // ---- CONFIRM ----
    if (["confirm", "c", "confirmed", "yes confirm"].includes(msg)) {
      const booking = await findNextBooking(clinic.id, phone);
      if (booking && booking.status !== "confirmed") {
        await db().from("bookings")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
          .eq("id", booking.id);
        await sendSMS(from, `Confirmed! See you ${speakableSlot(booking.starts_at, clinic.timezone)} at ${clinic.name}.`);
      } else {
        await sendSMS(from, `Thanks! We look forward to seeing you. Call ${clinicPhone} with questions.`);
      }
      return xml();
    }

    // ---- CANCEL ----
    if (["cancel", "cancelled"].includes(msg)) {
      const booking = await findNextBooking(clinic.id, phone);
      if (booking) {
        await db().from("bookings")
          .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
          .eq("id", booking.id);
        await sendSMS(from, `Your ${booking.service} on ${speakableSlot(booking.starts_at, clinic.timezone)} at ${clinic.name} is cancelled. Call ${clinicPhone} to rebook.`);
      } else {
        await sendSMS(from, `No upcoming appointment found. Call ${clinicPhone} for help.`);
      }
      return xml();
    }

    // ---- WAITLIST [service] ----
    if (msg.startsWith("waitlist")) {
      const service = rawBody.trim().slice(8).trim() || "Teeth cleaning";
      const { data: existing } = await db().from("waitlist")
        .select("id, service").eq("clinic_id", clinic.id).eq("phone", phone)
        .in("status", ["waiting", "offered"]).is("deleted_at", null).maybeSingle();
      if (existing) {
        await sendSMS(from, `You're already on the waitlist for ${existing.service} at ${clinic.name}. We'll reach out when a slot opens!`);
      } else {
        const { data: p } = await db().from("patients")
          .select("name").eq("clinic_id", clinic.id).eq("phone", phone).maybeSingle();
        await db().from("waitlist").insert({
          clinic_id: clinic.id, patient_name: p?.name || "Patient",
          phone, service, status: "waiting", priority: 5,
        });
        await sendSMS(from, `You're on the waitlist for ${service} at ${clinic.name}! We'll reach out as soon as a slot opens. Reply REMOVE to leave.`);
      }
      return xml();
    }

    // ---- REMOVE ----
    if (["remove", "removeme", "remove me"].includes(msg)) {
      const { data: entry } = await db().from("waitlist")
        .select("id, service").eq("clinic_id", clinic.id).eq("phone", phone)
        .in("status", ["waiting", "offered"]).maybeSingle();
      if (entry) {
        await db().from("waitlist")
          .update({ status: "declined", deleted_at: new Date().toISOString() }).eq("id", entry.id);
        await sendSMS(from, `Removed from the waitlist for ${entry.service} at ${clinic.name}. Call ${clinicPhone} when you're ready to book.`);
      } else {
        await sendSMS(from, `You're not on the waitlist at ${clinic.name}.`);
      }
      return xml();
    }

    // ---- YES (claim a recent SMS waitlist offer) ----
    if (["yes", "y"].includes(msg)) {
      const since = new Date(Date.now() - 60 * 60_000).toISOString();
      const { data: job } = await db().from("waitlist_call_queue")
        .select("*").eq("clinic_id", clinic.id).eq("phone", phone)
        .eq("method", "sms").in("status", ["called", "calling"])
        .gte("attempted_at", since).order("attempted_at", { ascending: false })
        .limit(1).maybeSingle();
      if (!job || !job.slot_id) {
        await sendSMS(from, `Thanks! If you're replying about an opening, please call ${clinicPhone} — we couldn't match it automatically.`);
        return xml();
      }

      // claim the slot
      const { data: claimed } = await db().from("cancelled_slots")
        .update({ status: "processing" }).eq("id", job.slot_id).eq("status", "open")
        .select("starts_at, service").maybeSingle();
      if (!claimed) {
        await sendSMS(from, `Sorry — that slot was just taken. We'll keep you on the waitlist. — ${clinic.name}`);
        return xml();
      }

      // book through the tested atomic function
      const { data, error } = await db().rpc("book_appointment", {
        p_clinic: clinic.id,
        p_starts_at: claimed.starts_at,
        p_service: claimed.service ?? job.service ?? "Teeth cleaning",
        p_patient_name: job.patient_name,
        p_phone: phone,
        p_source: "waitlist",
        p_is_new_patient: false,
      });
      const result = (data as unknown as BookResult) ?? { ok: false, reason: "slot_taken" };
      if (error || !result.ok) {
        await db().from("cancelled_slots").update({ status: "open" }).eq("id", job.slot_id);
        await sendSMS(from, `Sorry, we couldn't book that. Please call ${clinicPhone}.`);
        return xml();
      }

      const now = new Date().toISOString();
      await db().from("cancelled_slots")
        .update({ status: "filled", filled_at: now, filled_by_waitlist_id: job.waitlist_id ?? undefined }).eq("id", job.slot_id);
      if (job.waitlist_id) await db().from("waitlist").update({ status: "booked" }).eq("id", job.waitlist_id);
      await db().from("waitlist_call_queue").update({ status: "booked", outcome: "booked_via_sms" }).eq("id", job.id);
      await db().from("waitlist_call_queue")
        .update({ status: "expired", outcome: "slot_filled_by_other" })
        .eq("slot_id", job.slot_id).in("status", ["pending", "calling", "called"]).neq("id", job.id);

      await sendSMS(from, smsWaitlistBooked({
        service: claimed.service ?? job.service ?? "appointment",
        startsAt: claimed.starts_at, timezone: clinic.timezone, clinicName: clinic.name, clinicPhone,
      }));
      const ownerPhone = clinic.owner_phone || clinic.twilio_phone;
      if (ownerPhone) {
        sendSMS(ownerPhone, smsOwnerWaitlistFilled({
          service: claimed.service ?? job.service ?? "appointment",
          startsAt: claimed.starts_at, timezone: clinic.timezone, patientName: job.patient_name,
        })).catch(() => {});
      }
      return xml();
    }

    // ---- HELP / fallback ----
    if (["help", "menu", "?"].includes(msg)) {
      await sendSMS(from, `${clinic.name} commands:\nSTATUS - your appointments\nCONFIRM - confirm visit\nCANCEL - cancel\nWAITLIST [service] - join waitlist\nREMOVE - leave waitlist\nCall ${clinicPhone} for help.`);
    }
    return xml();
  } catch (err) {
    console.error("[twilio-webhook] error:", err);
    return xml();
  }
}
