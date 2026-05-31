// ============================================================================
// GET /api/health — liveness + readiness. Config is validated centrally by
// env() at boot, so here we verify the process is up and the database is
// reachable (a real readiness signal, not just "are env vars present").
// ============================================================================
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    // cheap connectivity probe
    const { error } = await db().from("clinics").select("id").limit(1);
    if (error) {
      return NextResponse.json({ status: "degraded", db: "error", detail: error.message }, { status: 503 });
    }
    return NextResponse.json({ status: "ok", db: "ok", ts: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ status: "down", detail: String(err) }, { status: 503 });
  }
}
