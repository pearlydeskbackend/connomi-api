// ============================================================================
// POST /api/vapi/end-of-call — Vapi server webhook (not a tool call).
// Two message types:
//   status-update      -> track active_calls (drives the live dashboard feed)
//   end-of-call-report -> log the call, alert owner if unresolved, send recall
//                         follow-up SMS when a recall call went unanswered.
// Idempotent: a duplicate end-of-call-report for the same call_id is ignored.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { env } from "@/config/env";
import { sendSMS, smsRecallFollowUp, smsRecallFinal } from "@/lib/twilio";
import type { Enums } from "@/lib/database.types";

export const dynamic = "force-dynamic";

const NO_ANSWER = [
  "voicemail", "no-answer", "no_answer", "busy", "failed",
  "machine-detected", "machine-start-of-speech-detected",
  "customer-did-not-answer", "customer_did_not_answer",
];

const ok = () => NextResponse.json({ received: true });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const message = body?.message as Record<string, unknown> | undefined;
    if (!message) return ok();
    const type = message.type as string;

    // ---- status-update: maintain the live active_calls feed ----
    if (type === "status-update") {
      const status = message.status as string;
      const call = message.call as Record<string, unknown> | undefined;
      if (!call) return ok();

      const callId = call.id as string;
      const toNumber = (call.phoneNumber as Record<string, unknown>)?.number as string | undefined;
      const customerPhone = (call.customer as Record<string, unknown>)?.number as string | undefined;
      const clinicId = (call.metadata as Record<string, string> | undefined)?.clinic_id ?? null;

      const clinic = await resolveClinic(clinicId, toNumber ?? null);
      if (!clinic) return ok();

      if (status === "in-progress") {
        await db().from("active_calls").upsert(
          {
            call_id: callId,
            clinic_id: clinic.id,
            phone: customerPhone ?? null,
            state: "active" as Enums<"call_state">,
          },
          { onConflict: "call_id" },
        );
      } else if (status === "ended") {
        await db().from("active_calls")
          .update({ state: "ended" as Enums<"call_state">, ended_at: new Date().toISOString() })
          .eq("call_id", callId);
      }
      return ok();
    }

    // ---- end-of-call-report ----
    if (type !== "end-of-call-report") return ok();

    const analysis = message.analysis as Record<string, unknown> | undefined;
    const structured = analysis?.structuredData as Record<string, string> | undefined;
    const call = message.call as Record<string, unknown> | undefined;
    const clinicId = (call?.metadata as Record<string, string> | undefined)?.clinic_id ?? null;
    const toNumber = (call?.phoneNumber as Record<string, unknown> | undefined)?.number as string | undefined;
    const endedReason = (message.endedReason as string) || "unknown";
    const assistantId = (call?.assistantId as string) || "";
    const customerPhone = (call?.customer as Record<string, unknown> | undefined)?.number as string | undefined;
    const callId = ((message.id ?? call?.id) as string) || null;
    const direction: Enums<"call_direction"> =
      (call?.type as string) === "outboundPhoneCall" ? "outbound" : "inbound";

    const clinic = await resolveClinic(clinicId, toNumber ?? null);
    const outcome = structured?.callOutcome || "unknown";
    const summary = (analysis?.summary as string) || "";

    // idempotency: skip if this call is already logged
    if (callId) {
      const { data: dup } = await db().from("call_logs").select("id").eq("call_id", callId).maybeSingle();
      if (dup) return NextResponse.json({ received: true, duplicate: true });
    }

    // resolve patient name from phone (best effort)
    let patientName: string | null = null;
    if (customerPhone && clinic) {
      const { data: p } = await db().from("patients")
        .select("name").eq("clinic_id", clinic.id).eq("phone", customerPhone).maybeSingle();
      patientName = p?.name ?? null;
    }

    await db().from("call_logs").insert({
      clinic_id: clinic?.id ?? "",
      call_id: callId,
      direction,
      patient_name: patientName,
      phone: customerPhone ?? null,
      duration_seconds: (message.durationSeconds as number) || 0,
      outcome,
      sentiment: structured?.patientSentiment || "neutral",
      summary,
      transcript: (message.transcript as string) || "",
      cost_usd: (message.cost as number) || 0,
      ended_reason: endedReason,
    });

    // alert owner on an unresolved call
    if (outcome === "unresolved" && clinic?.owner_phone && summary) {
      sendSMS(clinic.owner_phone, `Connomi AI had trouble with a call. Summary: ${summary}. Check your dashboard.`, clinic.twilio_phone ?? undefined)
        .catch((e) => console.error("[end-of-call] owner SMS:", e));
    }

    // recall follow-up SMS when a recall/reengagement call went unanswered
    const isRecall =
      assistantId === process.env.VAPI_RECALL_ASSISTANT_ID ||
      assistantId === process.env.VAPI_REENGAGEMENT_ASSISTANT_ID;
    const noAnswer = NO_ANSWER.some((r) => endedReason.toLowerCase().includes(r));

    if (isRecall && noAnswer && customerPhone && clinic) {
      const clinicPhone = clinic.twilio_phone || clinic.owner_phone || "";
      const { data: p } = await db().from("patients")
        .select("name, recall_sequence_step")
        .eq("clinic_id", clinic.id).eq("phone", customerPhone).maybeSingle();
      if (p) {
        const step = p.recall_sequence_step ?? 0;
        const sent = await sendSMS(
          customerPhone,
          step >= 2
            ? smsRecallFinal({ name: p.name, clinicName: clinic.name, clinicPhone })
            : smsRecallFollowUp({ name: p.name, clinicName: clinic.name, clinicPhone, step: step + 1 }),
          clinic.twilio_phone ?? undefined,
        );
        if (sent) {
          await db().from("patients")
            .update({ last_contacted_at: new Date().toISOString() })
            .eq("clinic_id", clinic.id).eq("phone", customerPhone);
        }
      }
    }

    return ok();
  } catch (err) {
    console.error("[end-of-call] error:", err);
    return ok();
  }
}
