import crypto from 'crypto';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
    return res.json({
      ok: true,
      message: 'Daily payout cron completed',
      ...result,
    });
  } catch (err) {
    console.error('[cPanel Cron] HTTP job error:', err.message);
    return res.status(500).json({ error: err.message || 'Cron job failed' });
  }
}
