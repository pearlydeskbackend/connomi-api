// ============================================================================
// lib/vapi.ts — Vapi webhook helpers. Ported from v1 (which was solid) onto
// config constants — no magic numbers, no hardcoded fallback phone. Handles:
// log redaction, in-memory rate limiting, webhook secret verify, robust tool-
// call extraction, and outbound call triggering with E.164 validation.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { RATE_LIMIT, E164 } from "@/config/app";
import { env } from "@/config/env";

// ---- sensitive-field redaction for logs ----
const SENSITIVE = new Set([
  "twilioauthtoken", "twilioaccountsid", "authorization", "token", "secret",
  "password", "key", "apikey", "api_key", "accesstoken", "access_token",
  "privatekey", "private_key",
]);

export function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((i) => redactSensitive(i, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? "[REDACTED]" : redactSensitive(v, depth + 1);
  }
  return out;
}

// ---- in-memory rate limiting ----
interface RateEntry { count: number; resetAt: number; }
const store = new Map<string, RateEntry>();

export function checkRateLimit(key: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const e = store.get(key);
  if (!e || now > e.resetAt) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return { allowed: true, remaining: RATE_LIMIT.max - 1 };
  }
  if (e.count >= RATE_LIMIT.max) return { allowed: false, remaining: 0 };
  e.count++;
  return { allowed: true, remaining: RATE_LIMIT.max - e.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store.entries()) if (now > e.resetAt) store.delete(k);
}, RATE_LIMIT.sweepMs);

// ---- webhook secret verification ----
export function verifyVapiSecret(req: NextRequest): boolean {
  const secret = env().VAPI_WEBHOOK_SECRET;
  if (!secret) return true; // unset = open (dev); set it in production
  return req.headers.get("x-connomi-secret") === secret;
}

// ---- response helpers (Vapi tool-result shape) ----
export function vapiSay(toolCallId: string, message: string): NextResponse {
  return NextResponse.json({ results: [{ toolCallId, result: message }] });
}

// ---- tool-call extraction (defensive against Vapi payload variations) ----
export interface ExtractedToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, string>;
  clinicId: string | null;
  toNumber: string | null;
}

export function extractToolCall(body: Record<string, unknown>): ExtractedToolCall | null {
  try {
    const message = (body?.message ?? body) as Record<string, unknown>;
    const toolCalls = (message?.toolCalls ?? message?.tool_calls) as
      | Array<Record<string, unknown>>
      | undefined;
    const toolCall = toolCalls?.[0];
    if (!toolCall) return null;

    const fn = (toolCall.function ?? toolCall.fn) as Record<string, unknown> | undefined;
    let args: Record<string, string> = {};
    const rawArgs = fn?.arguments ?? fn?.args;
    if (typeof rawArgs === "string") {
      try { args = JSON.parse(rawArgs); } catch { args = {}; }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, string>;
    }

    const call = (message?.call ?? body?.call) as Record<string, unknown> | undefined;
    const metadata = call?.metadata as Record<string, string> | undefined;
    const clinicId = metadata?.clinic_id ?? null;

    const phoneObj = (call?.phoneNumber ?? call?.phone_number ?? call?.to) as
      | Record<string, unknown> | string | undefined;
    let toNumber: string | null = null;
    if (typeof phoneObj === "string") toNumber = phoneObj;
    else if (phoneObj && typeof phoneObj === "object") {
      toNumber = ((phoneObj.number ?? phoneObj.phoneNumber) as string) ?? null;
    }
    if (!toNumber && typeof call?.to === "string") toNumber = call.to;

    return {
      toolCallId: String(toolCall.id ?? "unknown"),
      toolName: String(fn?.name ?? ""),
      args,
      clinicId,
      toNumber,
    };
  } catch (err) {
    console.error("[vapi] extractToolCall error:", err);
    return null;
  }
}

// ---- outbound call trigger (waitlist cascade, recall, etc.) ----
export async function triggerVapiCall(params: {
  assistantId: string;
  phoneNumberId: string;
  customerPhone: string;
  customerName: string;
  variables?: Record<string, string>;
}): Promise<boolean> {
  if (!E164.test(params.customerPhone)) {
    console.error("[vapi] invalid E.164, skipping call:", params.customerPhone);
    return false;
  }
  try {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env().VAPI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: params.assistantId,
        phoneNumberId: params.phoneNumberId,
        customer: { number: params.customerPhone, name: params.customerName },
        assistantOverrides: {
          variableValues: { patientName: params.customerName, ...(params.variables ?? {}) },
        },
      }),
    });
    if (!res.ok) {
      console.error("[vapi] call failed:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[vapi] triggerVapiCall error:", err);
    return false;
  }
}

// ---- clone a template Vapi assistant for a new clinic (onboarding) ----
export async function cloneVapiAssistant(params: {
  templateAssistantId: string;
  clinicName: string;
  clinicPhone: string;
  clinicHours: string;
  clinicDentists: string;
  clinicAddress: string;
}): Promise<string | null> {
  try {
    // fetch the template
    const tplRes = await fetch(`https://api.vapi.ai/assistant/${params.templateAssistantId}`, {
      headers: { Authorization: `Bearer ${env().VAPI_API_KEY}` },
    });
    if (!tplRes.ok) {
      console.error("[vapi] clone: template fetch failed", tplRes.status);
      return null;
    }
    const tpl = (await tplRes.json()) as Record<string, unknown>;

    // strip server-managed fields, keep the behavior config
    delete tpl.id; delete tpl.orgId; delete tpl.createdAt; delete tpl.updatedAt;
    tpl.name = `${params.clinicName} Receptionist`;

    const createRes = await fetch("https://api.vapi.ai/assistant", {
      method: "POST",
      headers: { Authorization: `Bearer ${env().VAPI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(tpl),
    });
    if (!createRes.ok) {
      console.error("[vapi] clone: create failed", createRes.status, await createRes.text());
      return null;
    }
    const created = (await createRes.json()) as { id?: string };
    return created.id ?? null;
  } catch (err) {
    console.error("[vapi] cloneVapiAssistant error:", err);
    return null;
  }
}
