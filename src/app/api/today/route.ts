// ============================================================================
// GET /api/today — the dashboard's snapshot endpoint.
//
// SECURITY MODEL (the whole point of this route):
//   • The caller must send a Supabase session JWT as `Authorization: Bearer …`.
//   • We VERIFY that token server-side (auth.getUser), then read the user's
//     clinic_id from public.users. The clinic is derived ONLY from the verified
//     session — never from a query param, header, or request body.
//   • All data queries are filtered by that clinic_id, so a clinic can only ever
//     read its own data. RLS sits underneath as a second wall.
//
// Returns exactly the TodaySnapshot shape the dashboard's zod schema expects.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ---- CORS (the dashboard is a separate origin) -----------------------------
// Bearer-token auth (not cookies), so we don't need credentialed CORS. We
// reflect an allow-listed origin; falls back to DASHBOARD_URL or '*'.
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = [
    process.env.DASHBOARD_URL,
    "http://localhost:5173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
  ].filter(Boolean) as string[];
  const resolved = origin && allow.includes(origin) ? origin : allow[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": resolved,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status: number, origin: string | null): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export function OPTIONS(req: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

// ---- small time helpers (everything in the clinic's timezone) --------------
interface TZParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
}

function partsInTz(d: Date, tz: string): TZParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) m[p.type] = p.value;
  let hour = parseInt(m.hour ?? "0", 10);
  if (hour === 24) hour = 0; // some environments emit 24 for midnight
  return {
    year: m.year ?? "1970",
    month: m.month ?? "01",
    day: m.day ?? "01",
    hour,
    minute: parseInt(m.minute ?? "0", 10),
  };
}

function ymd(p: TZParts): string {
  return `${p.year}-${p.month}-${p.day}`;
}

function clockTime(iso: string, tz: string): {
  display: string;
  meridiem: "am" | "pm";
  minutesFromMidnight: number;
} {
  const p = partsInTz(new Date(iso), tz);
  const h12 = ((p.hour + 11) % 12) + 1;
  return {
    display: `${h12}:${String(p.minute).padStart(2, "0")}`,
    meridiem: p.hour < 12 ? "am" : "pm",
    minutesFromMidnight: p.hour * 60 + p.minute,
  };
}

function timeLabel(iso: string, tz: string): string {
  const c = clockTime(iso, tz);
  return `${c.display} ${c.meridiem}`;
}

function dateLabel(d: Date, tz: string): string {
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(d);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric" }).format(d);
  const mon = new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "long" }).format(d);
  return `${wd} · ${day} ${mon}`;
}

// Monday→Sunday date strings (YYYY-MM-DD) for the current week, in clinic tz.
function weekDates(now: Date, tz: string): { iso: string; label: string; isToday: boolean }[] {
  const today = ymd(partsInTz(now, tz));
  const anchor = new Date(`${today}T12:00:00Z`); // noon avoids DST date-flips
  const dow = anchor.getUTCDay(); // 0 Sun .. 6 Sat
  const sinceMonday = (dow + 6) % 7;
  const monday = new Date(anchor.getTime() - sinceMonday * 86_400_000);
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const out: { iso: string; label: string; isToday: boolean }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ iso, label: labels[i]!, isToday: iso === today });
  }
  return out;
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const ini = parts.map((w) => w[0]?.toUpperCase() ?? "").join("");
  return ini || "··";
}

function roleLabel(role: string | null): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Front Desk";
}

function deltaText(diff: number, suffix: string): string {
  if (diff === 0) return `No change ${suffix}`;
  return `${diff > 0 ? "+" : ""}${diff} ${suffix}`;
}

function trendOf(diff: number): "up" | "down" | "flat" {
  if (diff > 0) return "up";
  if (diff < 0) return "down";
  return "flat";
}

const ACTIVE_STATUSES = new Set(["scheduled", "confirmed", "completed"]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = req.headers.get("origin");
  const supa = db();

  // ---- 1) verify the session token ----
  const authz = req.headers.get("authorization") ?? "";
  const token = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
  if (!token) return json({ error: "missing_token" }, 401, origin);

  const { data: authData, error: authErr } = await supa.auth.getUser(token);
  if (authErr || !authData?.user) return json({ error: "invalid_token" }, 401, origin);
  const authUserId = authData.user.id;

  // ---- 2) clinic comes from the verified user row, nothing else ----
  const { data: urow, error: urErr } = await supa
    .from("users")
    .select("clinic_id, role")
    .eq("id", authUserId)
    .single();
  if (urErr || !urow?.clinic_id) return json({ error: "no_clinic_for_user" }, 403, origin);
  const clinicId = urow.clinic_id;

  const { data: clinic, error: cErr } = await supa
    .from("clinics")
    .select("name, timezone, active, vapi_assistant_id")
    .eq("id", clinicId)
    .single();
  if (cErr || !clinic) return json({ error: "clinic_not_found" }, 404, origin);
  const tz = clinic.timezone || "America/Vancouver";

  const now = new Date();
  const nowMs = now.getTime();
  const todayStr = ymd(partsInTz(now, tz));
  const yesterdayStr = ymd(partsInTz(new Date(nowMs - 86_400_000), tz));
  const localHour = partsInTz(now, tz).hour;

  // ---- 3) pull the data we need, scoped to this clinic ----
  const [overviewRes, todayBookingsRes, recentBookingsRes, recentCallsRes, metricsRes, waitingRes, weekRes] =
    await Promise.all([
      supa.from("clinic_overview").select("*").eq("clinic_id", clinicId).maybeSingle(),
      supa
        .from("bookings")
        .select("id, patient_name, service, is_new_patient, starts_at, status")
        .eq("clinic_id", clinicId)
        .eq("slot_date", todayStr)
        .is("deleted_at", null)
        .order("starts_at", { ascending: true }),
      supa
        .from("bookings")
        .select("id, patient_name, service, status, created_at, cancelled_at")
        .eq("clinic_id", clinicId)
        .gte("created_at", new Date(nowMs - 36 * 3_600_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(40),
      supa
        .from("call_logs")
        .select("id, direction, patient_name, phone, outcome, created_at")
        .eq("clinic_id", clinicId)
        .gte("created_at", new Date(nowMs - 36 * 3_600_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(50),
      supa
        .from("daily_metrics")
        .select("date, bookings, calls_total")
        .eq("clinic_id", clinicId)
        .in("date", [todayStr, yesterdayStr]),
      supa
        .from("waitlist")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("status", "waiting"),
      supa
        .from("bookings")
        .select("slot_date, status")
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
    ]);

  const ov = overviewRes.data;
  const todays = (todayBookingsRes.data ?? []).filter((b) => ACTIVE_STATUSES.has(b.status));

  // ---- summary + upcoming ----
  const appointmentCount = todays.length;
  const newPatientCount = todays.filter((b) => b.is_new_patient).length;
  const confirmedCount = todays.filter((b) => b.status === "confirmed" || b.status === "completed").length;
  const allConfirmed = appointmentCount > 0 && confirmedCount === appointmentCount;

  const upcomingAll = todays.filter((b) => new Date(b.starts_at).getTime() >= nowMs);
  const SHOW = 6;
  const upcoming = upcomingAll.slice(0, SHOW).map((b) => ({
    id: b.id,
    time: clockTime(b.starts_at, tz),
    patientName: b.patient_name || "Patient",
    service: b.service || "Appointment",
    isNewPatient: Boolean(b.is_new_patient),
  }));
  const remainingCount = Math.max(0, upcomingAll.length - upcoming.length);

  // ---- calls handled today (clinic-local) ----
  const callsToday = (recentCallsRes.data ?? []).filter(
    (c) => ymd(partsInTz(new Date(c.created_at), tz)) === todayStr,
  );
  const callsHandledToday = callsToday.length;

  // ---- deltas vs yesterday from daily_metrics ----
  const dmYesterday = (metricsRes.data ?? []).find((r) => r.date === yesterdayStr);
  const apptDiff = appointmentCount - (dmYesterday?.bookings ?? appointmentCount);
  const callsDiff = callsHandledToday - (dmYesterday?.calls_total ?? callsHandledToday);
  const waitingCount = waitingRes.count ?? 0;
  const waitlistActive = Number(ov?.waitlist_active ?? 0);

  const stats = [
    {
      id: "appointments",
      iconKey: "appointments" as const,
      value: String(appointmentCount),
      label: "Appointments today",
      delta: deltaText(apptDiff, "from yesterday"),
      trend: trendOf(apptDiff),
    },
    {
      id: "calls",
      iconKey: "calls" as const,
      value: String(callsHandledToday),
      label: "Calls handled",
      delta: deltaText(callsDiff, "from yesterday"),
      trend: trendOf(callsDiff),
    },
    {
      id: "waitlist",
      iconKey: "waitlist" as const,
      value: String(waitlistActive),
      label: "On the waitlist",
      delta: `${waitingCount} waiting`,
      trend: "flat" as const,
    },
  ];

  // ---- activity feed (bookings + cancellations + calls), newest first ----
  type Event = {
    id: string;
    tone: "olive" | "paprika" | "grey";
    lead: string;
    highlight: string;
    trail: string;
    time: string;
    ms: number;
  };
  const events: Event[] = [];
  for (const b of recentBookingsRes.data ?? []) {
    const name = b.patient_name || "A patient";
    const svc = b.service || "an appointment";
    if (b.cancelled_at && ymd(partsInTz(new Date(b.cancelled_at), tz)) === todayStr) {
      events.push({
        id: `bc-${b.id}`,
        tone: "paprika",
        lead: "Cancelled ",
        highlight: name,
        trail: ` — ${svc}`,
        time: timeLabel(b.cancelled_at, tz),
        ms: new Date(b.cancelled_at).getTime(),
      });
    } else if (ymd(partsInTz(new Date(b.created_at), tz)) === todayStr) {
      events.push({
        id: `bk-${b.id}`,
        tone: "olive",
        lead: "Booked ",
        highlight: name,
        trail: ` for ${svc}`,
        time: timeLabel(b.created_at, tz),
        ms: new Date(b.created_at).getTime(),
      });
    }
  }
  for (const c of callsToday) {
    const who = c.patient_name || c.phone || "Unknown caller";
    const verb = c.direction === "outbound" ? "Called " : "Call from ";
    events.push({
      id: `cl-${c.id}`,
      tone: "grey",
      lead: verb,
      highlight: who,
      trail: c.outcome ? ` — ${c.outcome}` : "",
      time: timeLabel(c.created_at, tz),
      ms: new Date(c.created_at).getTime(),
    });
  }
  events.sort((a, b) => b.ms - a.ms);
  const activity = events.slice(0, 6).map(({ ms: _ms, ...rest }) => rest);

  // ---- needs-attention (single item or null) ----
  const emergencyMessages = Number(ov?.emergency_messages ?? 0);
  let attention:
    | {
        id: string;
        title: string;
        titleAccent: string;
        titleTrail: string;
        body: string;
        primaryAction: string;
        dismissAction: string;
      }
    | null = null;
  if (emergencyMessages > 0) {
    attention = {
      id: "att-emergency",
      title: "You have ",
      titleAccent: `${emergencyMessages} emergency`,
      titleTrail: emergencyMessages === 1 ? " message" : " messages",
      body: "A patient flagged something urgent. Take a look before it slips.",
      primaryAction: "Review now",
      dismissAction: "Later",
    };
  } else if (waitlistActive > 0) {
    attention = {
      id: "att-waitlist",
      title: "There are ",
      titleAccent: `${waitlistActive} patients`,
      titleTrail: " on the waitlist",
      body: "Fill a cancellation from the waitlist to keep the day full.",
      primaryAction: "View waitlist",
      dismissAction: "Dismiss",
    };
  }

  // ---- week strip (booked appts per day, Mon→Sun) ----
  const wk = weekDates(now, tz);
  const inWeek = new Set(wk.map((d) => d.iso));
  const perDay: Record<string, number> = {};
  for (const b of weekRes.data ?? []) {
    if (!b.slot_date || !inWeek.has(b.slot_date)) continue;
    if (b.status === "cancelled" || b.status === "no_show") continue;
    perDay[b.slot_date] = (perDay[b.slot_date] ?? 0) + 1;
  }
  const days = wk.map((d, i) => ({
    id: `d${i}`,
    label: d.label,
    count: perDay[d.iso] ?? 0,
    isToday: d.isToday,
  }));
  const totalBooked = days.reduce((s, d) => s + d.count, 0);

  // ---- assemble the snapshot ----
  const snapshot = {
    clinic: {
      name: clinic.name || "Clinic",
      initials: initialsOf(clinic.name || ""),
      role: roleLabel(urow.role),
      pearlIsLive: Boolean(clinic.active) && Boolean(clinic.vapi_assistant_id),
    },
    dateLabel: dateLabel(now, tz),
    greeting: localHour < 12 ? "Good morning." : localHour < 17 ? "Good afternoon." : "Good evening.",
    summary: { appointmentCount, newPatientCount, allConfirmed },
    stats,
    upcoming,
    remainingCount,
    activity,
    attention,
    week: {
      totalBooked,
      summary: `${totalBooked} appointment${totalBooked === 1 ? "" : "s"} booked this week`,
      days,
    },
  };

  return json(snapshot, 200, origin);
}