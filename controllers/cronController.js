import crypto from 'crypto';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';
import { buildPayoutDebugReport } from '../services/payoutDebugService.js';

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

function assertCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'CRON_SECRET is not configured on the server' });
    return false;
  }

  const provided = req.query.secret || req.headers['x-cron-secret'];
  if (!secretsMatch(provided, expected)) {
    res.status(401).json({ error: 'Invalid cron secret' });
    return false;
  }
  return true;
}

export async function runDailyPayoutCron(req, res) {
  if (!assertCronSecret(req, res)) return;

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

/** GET /api/cron/debug-payout?secret=... — full ROI/wallet/DB diagnostic */
export async function debugPayoutCron(req, res) {
  if (!assertCronSecret(req, res)) return;

  try {
    const asOfDate = req.query?.date || null;
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    const report = await buildPayoutDebugReport({ asOfDate });
    return res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[cPanel Cron] debug error:', err.message);
    return res.status(500).json({ error: err.message || 'Debug failed' });
  }
}
