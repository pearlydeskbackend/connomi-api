// ============================================================================
// lib/clinic.ts — resolve which clinic a call belongs to. Same proven
// multi-strategy approach as v1 (explicit id -> phone -> single-clinic
// fallback), now on the typed client. Reads agent_name etc. via the row type.
// ============================================================================
import { db, type Clinic } from "@/lib/supabase";
import { normalizePhone } from "@/lib/phone";
import { BRAND } from "@/config/app";

export async function getClinicById(id: string): Promise<Clinic | null> {
  const { data, error } = await db()
    .from("clinics")
    .select("*")
    .eq("id", id)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    console.error("[clinic] getClinicById:", error.message);
    return null;
  }
  return data;
}

export async function getClinicByPhone(phone: string): Promise<Clinic | null> {
  // try a few canonical forms; normalizePhone gives the primary E.164 form
  const canonical = normalizePhone(phone);
  const attempts = Array.from(
    new Set([canonical, phone, phone.replace(/\D/g, "")].filter(Boolean) as string[]),
  );
  for (const attempt of attempts) {
    const { data } = await db()
      .from("clinics")
      .select("*")
      .eq("twilio_phone", attempt)
      .eq("active", true)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

export async function resolveClinic(
  clinicId: string | null,
  toNumber: string | null,
): Promise<Clinic | null> {
  if (clinicId) {
    const c = await getClinicById(clinicId);
    if (c) return c;
  }
  if (toNumber) {
    const c = await getClinicByPhone(toNumber);
    if (c) return c;
  }
  // last resort: if exactly one active clinic exists, it's that one
  const { data } = await db().from("clinics").select("*").eq("active", true);
  if (data && data.length === 1) return data[0];
  console.error("[clinic] could not resolve clinic", { clinicId, toNumber });
  return null;
}

/** the name this clinic's receptionist introduces herself with */
export function agentNameFor(clinic: Clinic): string {
  return clinic.agent_name?.trim() || BRAND.agentName;
}
