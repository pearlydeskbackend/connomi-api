// ============================================================================
// POST /api/vapi/message — take a message for the clinic team, with urgency.
// Logs to messages, and for urgent/emergency texts the owner immediately.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { MessageSchema } from "@/lib/validators";
import { sendSMS, smsUrgentToOwner } from "@/lib/twilio";

export const dynamic = "force-dynamic";

const REPLY: Record<string, string> = {
  emergency: "I've flagged this as urgent and our team will call you back within 30 minutes.",
  urgent: "I've passed your message to our team and they'll call you back as soon as possible.",
  routine: "I've passed your message to our team and they'll call you back within one business day.",
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I'm having trouble with our system. Please call us directly.");
    toolCallId = tool.toolCallId;

    const parsed = MessageSchema.safeParse(tool.args);
    if (!parsed.success) return vapiSay(toolCallId, "Could I get your name and a brief message for our team?");

    const { patientName, patientPhone, message, urgency } = parsed.data;
    const phone = normalizePhone(patientPhone ?? "");
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber, tool.assistantId);
    if (!clinic) return vapiSay(toolCallId, "I'm having trouble with our system. Please call us directly.");

    await db().from("messages").insert({
      clinic_id: clinic.id,
      patient_name: patientName ?? "Unknown",
      phone: phone ?? patientPhone ?? null,
      body: message,
      urgency,
      status: "unread",
      source: "call",
    });

    if ((urgency === "urgent" || urgency === "emergency") && clinic.owner_phone) {
      await sendSMS(
        clinic.owner_phone,
        smsUrgentToOwner({
          patientName: patientName ?? "Unknown",
          phone: phone ?? patientPhone ?? "Unknown",
          message,
          urgency,
        }),
        clinic.twilio_phone ?? undefined,
      );
    }

    return vapiSay(toolCallId, REPLY[urgency] ?? REPLY.routine);
  } catch (err) {
    console.error("[message] unhandled:", err);
    return vapiSay(toolCallId, "I'm having some trouble. Please call us directly.");
  }
}
