// ============================================================================
// lib/speech.ts — turns slots/timestamps into natural spoken phrases for the
// AI receptionist. The DB owns scheduling correctness; this owns how it SOUNDS.
// All timezone-aware: a timestamptz is rendered in the clinic's local zone.
// ============================================================================

/** "Monday the 14th of July at 2:00 PM" — spoken-friendly, in clinic tz */
export function speakableSlot(iso: string, timezone: string): string {
  const dt = new Date(iso);
  const day = dt.toLocaleDateString("en-CA", { weekday: "long", timeZone: timezone });
  const month = dt.toLocaleDateString("en-CA", { month: "long", timeZone: timezone });
  const dayNum = Number(dt.toLocaleDateString("en-CA", { day: "numeric", timeZone: timezone }));
  const time = dt.toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
  return `${day} the ${dayNum}${ordinal(dayNum)} of ${month} at ${time}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/** offer up to two alternatives in one natural sentence */
export function offerAlternatives(
  isos: string[],
  timezone: string,
  prefix: string,
): string {
  if (isos.length === 0) return `${prefix} What other day works for you?`;
  if (isos.length === 1) {
    return `${prefix} I have ${speakableSlot(isos[0], timezone)}. Does that work?`;
  }
  return `${prefix} I have ${speakableSlot(isos[0], timezone)}, or ${speakableSlot(
    isos[1],
    timezone,
  )} — which works better?`;
}
