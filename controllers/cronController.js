import crypto from 'crypto';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';
import { buildPayoutDebugReport } from '../services/payoutDebugService.js';
import { retryOpenSellPayouts } from '../services/sellOrderService.js';

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

/** GET/POST /api/cron/retry-sell-payouts?secret=... — retry USDT after XIT was received */
export async function retrySellPayoutsCron(req, res) {
  if (!assertCronSecret(req, res)) return;

  try {
    const result = await retryOpenSellPayouts();
    return res.json({
      ok: true,
      message: result.attempted
        ? `Retried ${result.attempted} pending sell(s): ${result.completed} paid, ${result.failed} still pending`
        : 'No pending sell payouts',
      ...result,
    });
  } catch (err) {
    console.error('[cPanel Cron] retry sell payouts error:', err.message);
    return res.status(500).json({ error: err.message || 'Retry sell payouts failed' });
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
