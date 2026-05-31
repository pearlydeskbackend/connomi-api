// ============================================================================
// lib/supabase.ts — typed service-role client for API routes / Sophie webhooks.
// Reads creds ONLY from the validated env() — never raw process.env.
// Bypasses RLS (service role); never import this into client-side code.
// ============================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { env } from "@/config/env";

export type DB = SupabaseClient<Database>;

let client: DB | null = null;

export function db(): DB {
  if (client) return client;
  const e = env();
  client = createClient<Database>(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "connomi-api" } },
  });
  return client;
}

// Re-export friendly row types for convenience across the codebase.
export type {
  Clinic,
  Booking,
  Patient,
  Provider,
  ClinicMessage,
  ClinicOverview,
  PatientHealth,
} from "@/lib/database.types";
