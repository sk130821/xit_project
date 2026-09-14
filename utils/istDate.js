/** Today's date in Asia/Kolkata (YYYY-MM-DD) — used for daily ROI at 12:00 AM IST. */
export function getISTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** DB Date / datetime string → YYYY-MM-DD in IST (never locale strings like "Mon Sep 14"). */
export function toISTDateString(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return getISTDateString(value);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return getISTDateString(parsed);
  return null;
}

/** Inclusive calendar-day count between two YYYY-MM-DD strings. */
export function daysBetweenYmd(startYmd, endYmd) {
  if (!startYmd || !endYmd) return 0;
  const t0 = Date.parse(`${startYmd}T00:00:00Z`);
  const t1 = Date.parse(`${endYmd}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  return Math.floor((t1 - t0) / (1000 * 60 * 60 * 24));
}
