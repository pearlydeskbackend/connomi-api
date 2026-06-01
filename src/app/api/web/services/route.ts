// ============================================================================
// POST /api/web/services — PUBLIC. Returns the clinic's bookable services so
// the widget can populate its dropdown dynamically (nothing hardcoded).
// Falls back to a sensible default list if the clinic hasn't configured
// service_durations yet. Body: { embedKey }.
// ============================================================================
import { NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { resolveWebContext, jsonCors, preflight } from "@/lib/web";

export const dynamic = "force-dynamic";

const DEFAULT_SERVICES = [
  "Teeth cleaning", "Checkup", "Filling", "Crown",
  "Root canal", "Extraction", "Whitening", "Consultation",
];

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

  const { data } = await db()
    .from("service_durations")
    .select("service, duration_minutes")
    .eq("clinic_id", clinic.id)
    .order("service", { ascending: true });

  const services = data && data.length
    ? data.map((s) => ({ name: s.service, durationMinutes: s.duration_minutes }))
    : DEFAULT_SERVICES.map((name) => ({ name, durationMinutes: 30 }));

  return jsonCors({
    ok: true,
    clinic: { name: clinic.name, agentName: clinic.agent_name ?? "Sophie" },
    services,
  });
}
