// ============================================================================
// POST /api/web/lead — PUBLIC. Captures a lead from the Connomi brand orb.
// The assistant calls this (as a tool) once the visitor has shared details AND
// the email has been read back and confirmed. Stores the lead in Supabase
// (never lost), then emails the owner via Resend (best-effort).
//
// Body: { embedKey, name?, email?, phone?, idea?, businessName? }
// At least one contact method (email or phone) is required.
//
// Env needed for the email step (optional — storing still works without it):
//   RESEND_API_KEY     your Resend key
//   LEAD_NOTIFY_TO     where lead emails should land (your inbox)
//   LEAD_NOTIFY_FROM   verified Resend sender, e.g. "Connomi <hello@connomi.studio>"
// ============================================================================
import { NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { resolveWebContext, jsonCors, preflight } from "@/lib/web";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const name = typeof body.name === "string" ? body.name.trim() : null;
  const idea = typeof body.idea === "string" ? body.idea.trim() : null;
  const businessName = typeof body.businessName === "string" ? body.businessName.trim() : null;
  const rawEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const rawPhone = typeof body.phone === "string" ? body.phone : null;

  const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null;
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (!email && !phone) {
    return jsonCors({ ok: false, error: "need_contact", message: "Need a valid email or phone." }, 400);
  }

  // 1) store first — the lead must never be lost
  const { data, error } = await db()
    .from("leads")
    .insert({
      clinic_id: clinic.id,
      name, email, phone, idea,
      business_name: businessName,
      source: "web_voice",
      status: "new",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[web/lead] store failed:", error);
    return jsonCors({ ok: false, error: "store_failed" }, 500);
  }

  // 2) email the owner via Resend (best-effort; lead is already safe)
  await notifyByEmail({ name, email, phone, idea, businessName }).catch((e) =>
    console.error("[web/lead] email notify failed:", e),
  );

  return jsonCors({ ok: true, leadId: data.id });
}

async function notifyByEmail(lead: {
  name: string | null; email: string | null; phone: string | null;
  idea: string | null; businessName: string | null;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_TO;
  const from = process.env.LEAD_NOTIFY_FROM;
  if (!key || !to || !from) {
    console.warn("[web/lead] email not configured (RESEND_API_KEY/LEAD_NOTIFY_TO/LEAD_NOTIFY_FROM)");
    return;
  }

  const subject = `New Connomi lead${lead.name ? ` — ${lead.name}` : ""}`;
  const lines = [
    lead.name ? `Name: ${lead.name}` : null,
    lead.businessName ? `Business: ${lead.businessName}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    lead.phone ? `Phone: ${lead.phone}` : null,
    "",
    "Their idea:",
    lead.idea || "(not specified)",
    "",
    "— Captured by the Connomi orb",
  ].filter((l) => l !== null);
  const text = (lines as string[]).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: lead.email ?? undefined,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
}
