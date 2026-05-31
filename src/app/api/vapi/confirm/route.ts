// ============================================================================
// POST /api/vapi/confirm — caller confirms they'll attend.
// v1 only bumped updated_at (didn't actually record confirmation). v2 sets the
// real lifecycle state: status -> 'confirmed', confirmed_at -> now. This makes
// "today_confirmed" on the dashboard meaningful and drives reminder logic.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveClinic } from "@/lib/clinic";
import { extractToolCall, vapiSay } from "@/lib/vapi";
import { normalizePhone } from "@/lib/phone";
import { findNextBooking } from "@/lib/lookup";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const tool = extractToolCall(body);
    if (!tool) return vapiSay("unknown", "Perfect — we'll see you then!");

    const phone = normalizePhone(tool.args.patientPhone ?? "");
    const clinic = await resolveClinic(tool.clinicId, tool.toNumber);

    if (phone && clinic) {
      const booking = await findNextBooking(clinic.id, phone);
      if (booking && booking.status !== "confirmed") {
        await db()
          .from("bookings")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
          .eq("id", booking.id);
      }
    }

    return vapiSay(tool.toolCallId, "Perfect — we'll see you then. Have a great day!");
  } catch (err) {
    console.error("[confirm] error:", err);
    return vapiSay("unknown", "Perfect — we'll see you then!");
  }
}
