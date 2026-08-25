/** Today's date in Asia/Kolkata (YYYY-MM-DD) — used for daily ROI at 12:00 AM IST. */
export function getISTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
