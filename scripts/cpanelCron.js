/**
 * cPanel Node fallback — daily ROI + Level + Royalty.
 * Prefer scripts/cpanel-cron.sh from cPanel Cron Jobs.
 */
import '../loadEnv.js';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';
import { pool } from '../db.js';

async function main() {
  console.log(`[cPanel Cron] Start ${new Date().toISOString()}`);
  try {
    const result = await runAutoRoiJob();
    console.log(
      `[cPanel Cron] Done — investments ${result.investmentsProcessed} · ROI ${Number(result.totalRoi).toFixed(2)} · Level ${Number(result.totalLevelBonus).toFixed(2)} · Reward ${Number(result.totalRewardBonus).toFixed(2)} · total ${Number(result.totalPayout).toFixed(2)}`
    );
  } catch (err) {
    console.error(`[cPanel Cron] Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
