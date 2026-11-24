const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** All money is integer cents (USD only, as in the backend). */
export const formatCents = (cents: number) => usd.format(cents / 100);

/** Cents as a plain input value: 123450 -> "1234.50". */
export const centsToInput = (cents: number) => (cents / 100).toFixed(2);

/**
 * Parses what a person types as an amount, without floating point: "1,234.5" -> 123450.
 * Null for anything that is not a whole number of cents.
 */
export function parseCents(input: string): number | null {
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/[$,\s]/g, ""));
  if (!m || (m[2] === "" && !m[3])) return null;
  const cents = Number(m[2] || "0") * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents : cents;
}

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A calendar date as the APIs send it ("2026-11-01"), shown without any timezone shift. */
export const formatDate = (iso: string | null | undefined) => (iso ? day.format(new Date(`${iso}T00:00:00Z`)) : "—");

/** Today in the browser's timezone, as YYYY-MM-DD. */
export const today = () => new Date().toLocaleDateString("en-CA");

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const stamp = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** A timestamp as "3 minutes ago", falling back to a date after a week. */
export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  return stamp.format(new Date(iso));
}

export const formatStamp = (iso: string) => stamp.format(new Date(iso));
