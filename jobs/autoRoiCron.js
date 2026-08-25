import { runPayout } from '../services/payoutService.js';

function msUntilMidnightIST() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
  const h = get('hour');
  const m = get('minute');
  const s = get('second');
  const elapsed = h * 3600 + m * 60 + s;
  return (86400 - elapsed) * 1000;
}

export async function runAutoRoiJob() {
  const result = await runPayout({ runType: 'auto', triggeredBy: 'system' });
  if (result.skipped) {
    console.log(`[Auto ROI] Skipped — already ran for IST date ${result.runDate}`);
    return result;
  }
  if (result.investmentsProcessed > 0) {
    console.log(
      `[Auto ROI] ${result.investmentsProcessed} investments · ROI ${result.totalRoi.toFixed(2)} · Level ${result.totalLevelBonus.toFixed(2)} · Reward ${result.totalRewardBonus.toFixed(2)} XIT`
    );
  } else {
    console.log(`[Auto ROI] No eligible investments for ${result.payoutDate}`);
  }
  return result;
}

export function startAutoRoiCron() {
  if (process.env.AUTO_ROI_CRON === 'false') {
    console.log('Auto ROI cron disabled');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilMidnightIST();
    setTimeout(async () => {
      try {
        await runAutoRoiJob();
      } catch (err) {
        console.error('[Auto ROI] Job error:', err.message);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
  console.log('Auto ROI cron scheduled (daily 12:00 AM IST — ROI + Level + Royalty)');
}
