// ============================================================================
// config/env.ts — the ONLY place process.env is read. Validated once, at boot,
// with Zod. If a required secret is missing, the app fails loudly at startup
// instead of mysteriously at 2am on a live call. Nothing downstream touches
// process.env directly.
// ============================================================================
import { z } from "zod";

const EnvSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1).optional(),

  // Vapi
  VAPI_API_KEY: z.string().min(1),
  VAPI_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Platform
  DASHBOARD_URL: z.string().url().default("https://app.connomi.com"),
  BILLING_URL: z.string().url().default("https://connomi.com/billing"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // fail loud, fail early — never boot half-configured
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[config] Invalid or missing environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
