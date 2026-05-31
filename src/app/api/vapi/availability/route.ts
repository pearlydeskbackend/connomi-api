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

// Parse a spoken/written time into minutes-of-day (0-1439), or null if unparseable.
// Handles: "10am", "10 AM", "10:00am", "10:00 AM", "2:30pm", "14:30", "9", "9:15".
function parseTimeToMinutes(input: string): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\./g, ""); // "a.m." -> "am"
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  return hour * 60 + min;
}

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

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber, tool.assistantId);
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
      // Normalize the requested time to 24h minutes-of-day, robustly.
      const wantMinutes = parseTimeToMinutes(requestedTime);
      const match = open.find((s) => {
        // slot start in clinic-local 24h "HH:MM"
        const hhmm = new Date(s.starts_at).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: clinic.timezone,
        });
        const [h, m] = hhmm.split(":").map(Number);
        const slotMinutes = h * 60 + m;
        return wantMinutes !== null && slotMinutes === wantMinutes;
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