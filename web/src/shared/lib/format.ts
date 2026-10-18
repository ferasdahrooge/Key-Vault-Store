/** Display formatting for dates, relative times, expiry badges and durations, plus the slug pattern. */
// Localised date and time, or an em dash when missing/invalid.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Localised date only.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** "in 3 days", "5 minutes ago" in the browser's locale. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  // Pick the largest unit that fits.
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400_000],
    ['month', 30 * 86400_000],
    ['day', 86400_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), 'second');
}

// Expiry classification used for badges.
export type ExpiryState = { kind: 'none' } | { kind: 'expired' } | { kind: 'soon'; days: number } | { kind: 'ok'; days: number };

/** Classifies an expiry date for badges: none, expired, soon (within `soonDays`) or ok. */
export function expiryState(iso: string | null | undefined, now = Date.now(), soonDays = 14): ExpiryState {
  if (!iso) return { kind: 'none' };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { kind: 'none' };
  if (t <= now) return { kind: 'expired' };
  const days = Math.ceil((t - now) / 86400_000);
  return days <= soonDays ? { kind: 'soon', days } : { kind: 'ok', days };
}

/** Minutes as the largest whole unit: 1440 → "1 day", 240 → "4 hours", 90 → "90 min". */
export function formatDuration(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  return `${min} min`;
}

// Validation patterns shared with the server.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const EJSON_PUBKEY_RE = /^[0-9a-f]{64}$/i;
