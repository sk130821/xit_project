/**
 * Backdate DB by 1 IST day so today's auto ROI cron can pay.
 * Usage: node scripts/backdateOneDayForRoiTest.js
 */
import '../loadEnv.js';
import { pool } from '../db.js';
import { getISTDateString } from '../utils/istDate.js';

const istToday = getISTDateString();
const [y, m, d] = istToday.split('-').map(Number);
const yesterdayDate = new Date(Date.UTC(y, m - 1, d));
yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
const istYesterday = yesterdayDate.toISOString().slice(0, 10);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[dbInfo]] = await conn.query('SELECT DATABASE() AS db');

  const [invBefore] = await conn.query(
    `SELECT id, user_id, token_amount, last_roi_date, status FROM investments WHERE status = 'active'`
  );

  // last_roi = yesterday → cron today pays 1 day ROI
  const [uInv] = await conn.query(
    `UPDATE investments
     SET last_roi_date = ?,
         created_at = DATE_SUB(created_at, INTERVAL 1 DAY),
         end_date = DATE_SUB(end_date, INTERVAL 1 DAY)
     WHERE status = 'active'`,
    [istYesterday]
  );

  const [uTx] = await conn.query(
    `UPDATE transactions SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY)`
  );

  const [uUsers] = await conn.query(
    `UPDATE users SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY)`
  );

  // allow today's auto cron to run
  const [delPay] = await conn.query(
    `DELETE FROM payout_runs WHERE run_date = ? AND run_type = 'auto'`,
    [istToday]
  );

  await conn.commit();

  const [invAfter] = await conn.query(
    `SELECT id, user_id, token_amount, last_roi_date, DATE(created_at) AS created_day, status
     FROM investments WHERE status = 'active' ORDER BY id`
  );

  console.log('Backdate for ROI test complete');
  console.log({
    database: dbInfo.db,
    istToday,
    last_roi_set_to: istYesterday,
    investmentsUpdated: uInv.affectedRows,
    transactionsUpdated: uTx.affectedRows,
    usersUpdated: uUsers.affectedRows,
    deletedTodayAutoPayoutRuns: delPay.affectedRows,
    before: invBefore.map((r) => ({ id: r.id, last_roi: r.last_roi_date })),
    after: invAfter,
  });
  console.log('\nAb cron chalao — 1 din ka ROI milna chahiye.');
} catch (err) {
  await conn.rollback();
  console.error('Backdate failed:', err.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
