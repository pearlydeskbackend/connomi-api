// ============================================================================
// lib/phone.ts — phone helpers. normalizePhone() MUST stay byte-identical to
// the DB normalize_phone() function, or patient matching drifts. Both produce
// E.164 (+1XXXXXXXXXX for North America).
// ============================================================================

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length > 0) return `+${d}`;
  return null;
}

/** mask for logs — never log full patient numbers */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return "****";
  return `***-***-${phone.slice(-4)}`;
}
