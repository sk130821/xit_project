import crypto from 'crypto';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function runDailyPayoutCron(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on the server' });
  }

  const provided = req.query.secret || req.headers['x-cron-secret'];
  if (!secretsMatch(provided, expected)) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }

  try {
    const result = await runAutoRoiJob();
    const message = result.skipped
      ? 'Daily payout already completed for today (IST)'
      : 'Daily payout cron completed';
    return res.json({
      ok: true,
      skipped: !!result.skipped,
      message,
      istDate: result.runDate || result.payoutDate,
      ...result,
    });
  } catch (err) {
    console.error('[cPanel Cron] HTTP job error:', err.message);
    return res.status(500).json({ error: err.message || 'Cron job failed' });
  }
}
