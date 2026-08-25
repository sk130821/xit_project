/**
 * Run from server SSH to test cron without waiting for cPanel schedule:
 *   cd /home/xittoken/back.xittoken.co && node scripts/testCron.js
 */
import '../loadEnv.js';
import { runAutoRoiJob } from '../jobs/autoRoiCron.js';
import { pool } from '../db.js';
import { getISTDateString } from '../utils/istDate.js';

async function main() {
  console.log('=== XIT Cron Test ===');
  console.log('IST date:', getISTDateString());
  console.log('CRON_SECRET set:', !!process.env.CRON_SECRET);
  console.log('AUTO_ROI_CRON:', process.env.AUTO_ROI_CRON ?? '(not set)');

  if (!process.env.CRON_SECRET) {
    console.error('ERROR: Add CRON_SECRET to .env and restart Node app');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runAutoRoiJob();
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
