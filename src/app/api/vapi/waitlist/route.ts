// ============================================================================
// POST /api/vapi/waitlist — add a caller to the waitlist.
// Faithful v2 port: dedup against active entries, parse spoken "Monday and
// Wednesday" into the consolidated preferred_days int[] (v2 dropped the
// redundant preferred_day_numbers / preferred_time_of_day columns).
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay, checkRateLimit } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { WaitlistSchema } from "@/lib/validators";
import { CADENCE } from "@/config/app";

export const dynamic = "force-dynamic";

const DAY_NUM: Record<string, number> = {
  sunday: 7, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function parseDays(spoken?: string): number[] {
  if (!spoken) return [];
  const lower = spoken.toLowerCase();
  const nums: number[] = [];
  for (const [name, n] of Object.entries(DAY_NUM)) if (lower.includes(name)) nums.push(n);
  return nums;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let toolCallId = "unknown";
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "I'm having trouble with our system. Please call us directly.");
    toolCallId = tool.toolCallId;

    const rl = checkRateLimit(`waitlist:${tool.toNumber ?? toolCallId}`);
    if (!rl.allowed) return vapiSay(toolCallId, "I'm having trouble right now. Please call us directly.");

    const parsed = WaitlistSchema.safeParse(tool.args);
    if (!parsed.success) return vapiSay(toolCallId, "Could I get your name and phone number to add you to the waitlist?");

    const { patientName, patientPhone, service, preferredDays, preferredTimes } = parsed.data;
    const phone = normalizePhone(patientPhone);
    if (!phone) return vapiSay(toolCallId, "I couldn't read that phone number. Could you repeat it?");

    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);
    if (!clinic) return vapiSay(toolCallId, "I'm having trouble with our system. Please call us directly.");

    // Dedup: already on the list (waiting or just offered)?
    const { data: existing } = await db()
      .from("waitlist")
      .select("id, status, service")
      .eq("clinic_id", clinic.id)
      .eq("phone", phone)
      .in("status", ["waiting", "offered"])
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();

    if (existing) {
      const msg = existing.status === "offered"
        ? "We actually just reached out to you about an opening!"
        : "You're already on our waitlist!";
      return vapiSay(toolCallId, `${msg} We'll let you know as soon as a ${existing.service || "slot"} opens up. Anything else?`);
    }

    const { error } = await db().from("waitlist").insert({
      clinic_id: clinic.id,
      patient_name: patientName,
      phone,
      service: service || "Teeth cleaning",
      preferred_days: parseDays(preferredDays),
      preferred_times: preferredTimes ?? null,
      status: "waiting",
      priority: 5,
    });
    if (error) {
      console.error("[waitlist] insert error:", error.message);
      return vapiSay(toolCallId, "I had trouble adding you to the waitlist. Please call us directly.");
    }

    void CADENCE.waitlistDefaultExpiryDays; // expiry default handled by DB column
    return vapiSay(toolCallId, `You're on the waitlist! We'll reach out as soon as a ${service || "slot"} opens up. Anything else I can help with?`);
  } catch (err) {
    console.error("[waitlist] unhandled:", err);
    return vapiSay(toolCallId, "I'm having some trouble. Please call us directly.");
  }
}
