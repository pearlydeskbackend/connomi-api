// ============================================================================
// POST /api/web/availability — PUBLIC. Powers the website booking form's
// time-slot picker. Body: { embedKey, service?, date (YYYY-MM-DD) }.
// Returns the open slots for that day from the SAME tested availability engine
// the phone uses. Clinic is resolved from the public embed key.
// ============================================================================
import { NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { resolveWebContext, jsonCors, preflight } from "@/lib/web";
import { speakableSlot } from "@/lib/speech";

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ ok: false, error: "invalid_json" }, 400);
  }

  const resolved = await resolveWebContext(req, body);
  if ("error" in resolved) return resolved.error;
  const { clinic } = resolved.ctx;

  const date = typeof body.date === "string" ? body.date : null;
  const service = typeof body.service === "string" ? body.service : "Teeth cleaning";
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonCors({ ok: false, error: "invalid_date", hint: "use YYYY-MM-DD" }, 400);
  }

  const { data: slots, error } = await db().rpc("get_available_slots", {
    p_clinic: clinic.id,
    p_date: date,
    p_service: service,
  });
  if (error) {
    return jsonCors({ ok: false, error: "availability_failed" }, 500);
  }

  // Shape slots for a UI: machine value (startsAt) + human label.
  const open = (slots ?? []).map((s) => ({
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    providerId: s.provider_id,
    providerName: s.provider_name,
    label: speakableSlot(s.starts_at, clinic.timezone),
  }));

  return jsonCors({
    ok: true,
    clinic: { name: clinic.name, timezone: clinic.timezone },
    date,
    service,
    slots: open,
  });
}
