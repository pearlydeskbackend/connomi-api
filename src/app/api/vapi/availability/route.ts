// ============================================================================
// POST /api/vapi/availability — Sophie asks "is this time free?"
// The tested get_available_slots() DB function owns all scheduling correctness
// (hours, holidays, durations, overlaps, PMS busy, past-slot guard). This route
// just (1) resolves the clinic, (2) asks the DB, (3) speaks the answer.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay, checkRateLimit } from "@/lib/vapi";
import { speakableSlot, offerAlternatives } from "@/lib/speech";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", JSON.stringify({ available: true }));
    toolCallId = tool.toolCallId;

    const rl = checkRateLimit(`avail:${tool.toNumber ?? toolCallId}`);
    if (!rl.allowed) return vapiSay(toolCallId, JSON.stringify({ available: true }));

    const { requestedDate, requestedTime, service } = tool.args as {
      requestedDate?: string;
      requestedTime?: string;
      service?: string;
    };
    if (!requestedDate) return vapiSay(toolCallId, JSON.stringify({ available: true }));

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);
    if (!clinic) {
      return vapiSay(toolCallId, JSON.stringify({ available: true, message: "proceed" }));
    }

    // Ask the tested engine for the day's real open slots (named params).
    const { data: slots, error } = await db().rpc("get_available_slots", {
      p_clinic: clinic.id,
      p_date: requestedDate,
      p_service: service,
    });
    if (error) {
      console.error("[availability] rpc error:", error.message);
      return vapiSay(toolCallId, JSON.stringify({ available: true, message: "proceed" }));
    }

    const open = slots ?? [];

    // If a specific time was requested, see if a slot starts then (clinic-local).
    if (requestedTime) {
      const match = open.find((s) => {
        const local = new Date(s.starts_at).toLocaleTimeString("en-CA", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: clinic.timezone,
        });
        return local.replace(/\s/g, "").toLowerCase() ===
          requestedTime.replace(/\s/g, "").toLowerCase();
      });
      if (match) {
        return vapiSay(
          toolCallId,
          JSON.stringify({
            available: true,
            startsAt: match.starts_at,
            providerId: match.provider_id,
            speechSuggestion: `That works — ${speakableSlot(
              match.starts_at,
              clinic.timezone,
            )}. Shall I book it?`,
          }),
        );
      }
    }

    // Not available (or no specific time): offer the next open slots.
    const alts = open.slice(0, 2).map((s) => s.starts_at);
    return vapiSay(
      toolCallId,
      JSON.stringify({
        available: false,
        alternatives: alts,
        speechSuggestion: offerAlternatives(
          alts,
          clinic.timezone,
          requestedTime ? "That time isn't open." : "Sure.",
        ),
      }),
    );
  } catch (err) {
    console.error("[availability] unhandled:", err);
    return vapiSay(toolCallId, JSON.stringify({ available: true, message: "proceed" }));
  }
}
