// ============================================================================
// lib/time-normalize.ts — make booking robust to whatever time format the
// voice agent sends. The agent (Vapi) does not reliably echo back the exact
// ISO+offset timestamp we hand it; it may send "2026-06-01T10:00:00" (no zone),
// "2026-06-01 10:00", or a UTC "Z" time meaning local. This anchors any of
// those to the CLINIC'S timezone and returns a proper ISO string with offset.
//
// If the input ALREADY has an explicit offset (e.g. ...+00:00 or ...-07:00),
// we trust it as-is — that's an unambiguous instant.
// ============================================================================

// Combine a YYYY-MM-DD date + a loose time ("10:00 AM", "10am", "14:30") into
// an ISO timestamp anchored to `timeZone`. Returns null if unparseable.
// This is what the voice agent's date+time fields feed into.
export function combineDateTime(
  dateStr: string,
  timeStr: string | null,
  timeZone: string,
): string | null {
  const dm = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;

  let minutes = 9 * 60; // sensible default 9:00 if no time given
  if (timeStr) {
    const parsed = parseClockToMinutes(timeStr);
    if (parsed !== null) minutes = parsed;
  }
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mi = String(minutes % 60).padStart(2, "0");
  return anchorToTimezone(`${dm[1]}-${dm[2]}-${dm[3]}T${h}:${mi}:00`, timeZone);
}

// "10:00 AM" / "10am" / "2:30 pm" / "14:30" -> minutes of day, or null.
function parseClockToMinutes(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  return hour * 60 + min;
}

function hasExplicitOffset(s: string): boolean {
  // ends with Z, or +HH:MM / -HH:MM after the time portion
  return /[zZ]$/.test(s.trim()) || /[+-]\d{2}:?\d{2}$/.test(s.trim());
}

// Compute a timezone's offset (minutes) at a given UTC instant.
function tzOffsetMinutes(date: Date, timeZone: string): number {
  // Format the instant in the target tz, parse it back as if UTC, diff = offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((a, p) => {
    if (p.type !== "literal") a[p.type] = p.value;
    return a;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour), Number(parts.minute), Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

// Anchor a wall-clock datetime string to `timeZone`, return ISO with offset.
// Returns null if the input can't be parsed into Y/M/D H:M.
export function anchorToTimezone(input: string, timeZone: string): string | null {
  if (!input) return null;
  const s = input.trim();

  // Already unambiguous (has Z or explicit offset) -> trust it.
  if (hasExplicitOffset(s)) {
    const t = new Date(s);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }

  // Parse "YYYY-MM-DD[ T]HH:MM[:SS]" as wall-clock numbers.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const Y = Number(y), Mo = Number(mo) - 1, D = Number(d), H = Number(h), Mi = Number(mi), Se = Number(se ?? "0");

  // First guess: treat the wall-clock as UTC, then correct by the tz offset
  // at that instant (handles DST correctly to within the standard edge cases).
  const guessUTC = Date.UTC(Y, Mo, D, H, Mi, Se);
  const offsetMin = tzOffsetMinutes(new Date(guessUTC), timeZone);
  const realInstant = guessUTC - offsetMin * 60000;
  const result = new Date(realInstant);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}
