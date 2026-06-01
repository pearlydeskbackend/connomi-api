// ============================================================================
// lib/web.ts — shared helpers for the PUBLIC web booking surface.
// These endpoints are called cross-origin from clinic websites, so they need:
//   • CORS headers (preflight + actual)
//   • embed-key auth (public per-clinic key, not secrets)
//   • rate limiting keyed by embed key (abuse protection on a public surface)
// Reused by the booking form API and the conversational widget API alike.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { getClinicByEmbedKey } from "@/lib/clinic";
import type { Clinic } from "@/lib/supabase";

// ---- CORS ----
// Clinic sites are third-party origins. We allow any origin for these PUBLIC
// booking endpoints (they're meant to be embedded anywhere) but expose only
// the minimal methods/headers. No credentials are used, so '*' is safe here.
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonCors(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// ---- public rate limiting (per embed key + IP) ----
// In-memory per instance; for true distributed limiting use Upstash/Redis in
// production. This still blunts naive abuse from a single source.
const hits = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20; // 20 booking actions/min per key+ip is plenty

export function rateLimit(key: string): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= MAX_PER_WINDOW) return false;
  rec.count++;
  return true;
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ---- embed-key resolution ----
// Accepts the embed key from body or the `x-embed-key` header.
export interface WebContext {
  clinic: Clinic;
  embedKey: string;
}

export async function resolveWebContext(
  req: NextRequest,
  body: Record<string, unknown>,
): Promise<{ ctx: WebContext } | { error: NextResponse }> {
  const embedKey =
    (typeof body.embedKey === "string" ? body.embedKey : null) ||
    req.headers.get("x-embed-key") ||
    "";

  if (!embedKey) {
    return { error: jsonCors({ ok: false, error: "missing_embed_key" }, 400) };
  }

  if (!rateLimit(`${embedKey}:${clientIp(req)}`)) {
    return { error: jsonCors({ ok: false, error: "rate_limited" }, 429) };
  }

  const clinic = await getClinicByEmbedKey(embedKey);
  if (!clinic) {
    return { error: jsonCors({ ok: false, error: "invalid_embed_key" }, 401) };
  }

  return { ctx: { clinic, embedKey } };
}
