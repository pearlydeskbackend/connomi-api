// ============================================================================
// lib/jobs/briefing.ts — morning owner SMS: "Sophie booked N while you slept",
// today's load, overdue recalls, unread messages. Reads the clinic_overview
// VIEW (live, can't drift) instead of running five separate count queries.
// ============================================================================
import { db } from "@/lib/supabase";
import { sendSMS } from "@/lib/twilio";
import { agentNameFor } from "@/lib/clinic";
import { BRAND } from "@/config/app";
import { env } from "@/config/env";
import type { Clinic } from "@/lib/supabase";

export interface BriefingResult { sent: number; clinics: number; }

export async function runBriefing(): Promise<BriefingResult> {
  const dashboardUrl = env().DASHBOARD_URL;

  const { data: clinics } = await db().from("clinics").select("*").eq("active", true);
  let sent = 0;
  const list = (clinics ?? []) as Clinic[];

  for (const clinic of list) {
    if (!clinic.owner_phone) continue;

    // live overview (one read, computed from source)
    const { data: ov } = await db()
      .from("clinic_overview").select("*").eq("clinic_id", clinic.id).maybeSingle();

    // bookings Sophie made in the last 12h, for the named list
    const since = new Date(Date.now() - 12 * 3_600_000).toISOString();
    const { data: overnight } = await db()
      .from("bookings")
      .select("patient_name, service, starts_at")
      .eq("clinic_id", clinic.id).eq("source", "ai")
      .gte("created_at", since).is("deleted_at", null)
      .order("starts_at", { ascending: true });

    const agent = agentNameFor(clinic);
    const overnightCount = overnight?.length ?? 0;
    const lines: string[] = [`Good morning, ${clinic.name}`, ""];

    if (overnightCount > 0) {
      lines.push(`${agent} booked ${overnightCount} appointment${overnightCount === 1 ? "" : "s"} overnight:`);
      for (const b of overnight ?? []) {
        const t = new Date(b.starts_at).toLocaleString("en-CA", {
          weekday: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: clinic.timezone,
        });
        lines.push(`  - ${b.patient_name}: ${b.service} (${t})`);
      }
      lines.push("");
    } else {
      lines.push("No new bookings overnight.");
    }

    lines.push(`Today: ${ov?.today_bookings ?? 0} scheduled, ${ov?.today_confirmed ?? 0} confirmed.`);
    if ((ov?.patients_recall_due ?? 0) > 0) lines.push(`${ov!.patients_recall_due} overdue for recall.`);
    if ((ov?.unread_messages ?? 0) > 0) lines.push(`${ov!.unread_messages} unread message(s).`);
    if ((ov?.waitlist_active ?? 0) > 0) lines.push(`${ov!.waitlist_active} on the waitlist.`);
    lines.push("", `— ${BRAND.product}`, dashboardUrl);

    const ok = await sendSMS(clinic.owner_phone, lines.join("\n"), clinic.twilio_phone ?? undefined);
    if (ok) sent++;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { sent, clinics: list.length };
}
