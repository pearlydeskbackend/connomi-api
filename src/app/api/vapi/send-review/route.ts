// ============================================================================
// POST /api/vapi/send-review — text the clinic's Google review link to the
// caller and stamp review_sent_at on their most recent completed booking.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { sendSMS, smsReview } from "@/lib/twilio";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I've sent the review link to your phone.");
    toolCallId = tool.toolCallId;

    const phone = normalizePhone(tool.args.patientPhone ?? "");
    if (!phone) return vapiSay(toolCallId, "I couldn't send that link. Please call us and we'll get it to you.");

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);
    if (!clinic) return vapiSay(toolCallId, "I had trouble sending that. Please call us directly.");
    if (!clinic.google_review_link) {
      return vapiSay(toolCallId, "We don't have a review link set up yet, but thank you so much — it means a lot!");
    }

    await sendSMS(phone, smsReview({
      name: tool.args.patientName || "there",
      clinicName: clinic.name,
      reviewLink: clinic.google_review_link,
    }), clinic.twilio_phone ?? undefined);

    // stamp the most recent completed booking for this patient (best effort)
    const { data: booking } = await db()
      .from("bookings")
      .select("id")
      .eq("clinic_id", clinic.id)
      .eq("phone", phone)
      .eq("status", "completed")
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (booking) {
      await db().from("bookings").update({ review_sent_at: new Date().toISOString() }).eq("id", booking.id);
    }

    return vapiSay(toolCallId, "I've just sent the review link to your phone. Thank you so much — it really helps our team!");
  } catch (err) {
    console.error("[send-review] error:", err);
    return vapiSay(toolCallId, "I had trouble sending that. Please call us directly.");
  }
}
