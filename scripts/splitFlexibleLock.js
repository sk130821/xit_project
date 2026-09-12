/**
 * One-time: move 20% locked slice of old Flexible rows into Flexible Lock.
 * Does not change roi_received or users.total_invested.
 *
 *   node scripts/splitFlexibleLock.js
 */
import '../loadEnv.js';
import { pool } from '../db.js';

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.query(
      "ALTER TABLE investments MODIFY plan_type ENUM('lock', 'flexible', 'flexible_lock') NOT NULL"
    );
  } catch (err) {
    if (!String(err.message || '').includes('flexible_lock')) {
      console.warn('ENUM alter:', err.message);
    }
  }

  const [colRows] = await conn.query(
    "SHOW COLUMNS FROM investments LIKE 'income_eligible'"
  );
  const hasIncomeEligible = colRows.length > 0;

  await conn.beginTransaction();
  try {
    const [rows] = await conn.query(
      `SELECT * FROM investments
       WHERE plan_type = 'flexible' AND locked_amount > 0
       ORDER BY id
       FOR UPDATE`
    );

    let created = 0;
    for (const inv of rows) {
      const lockedAmt = roundXit(inv.locked_amount);
      const flexAmt = roundXit(Number(inv.token_amount) - lockedAmt);
      if (lockedAmt <= 0 || flexAmt <= 0) {
        console.warn(`skip id=${inv.id} flex=${flexAmt} locked=${lockedAmt}`);
        continue;
      }

      const sellable = Math.min(roundXit(inv.sellable_amount), flexAmt);

      if (hasIncomeEligible) {
        await conn.query(
          `INSERT INTO investments
            (user_id, plan_type, token_amount, total_return, daily_roi_rate, roi_received,
             sellable_amount, locked_amount, start_date, end_date, last_roi_date, status, income_eligible, created_at)
           VALUES (?, 'flexible_lock', ?, ?, 0.82, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inv.user_id,
            lockedAmt,
            roundXit(lockedAmt * 4),
            lockedAmt,
            inv.start_date,
            inv.end_date,
            inv.last_roi_date,
            inv.status,
            inv.income_eligible != null ? inv.income_eligible : 1,
            inv.created_at,
          ]
        );
      } else {
        await conn.query(
          `INSERT INTO investments
            (user_id, plan_type, token_amount, total_return, daily_roi_rate, roi_received,
             sellable_amount, locked_amount, start_date, end_date, last_roi_date, status, created_at)
           VALUES (?, 'flexible_lock', ?, ?, 0.82, 0, 0, ?, ?, ?, ?, ?, ?)`,
          [
            inv.user_id,
            lockedAmt,
            roundXit(lockedAmt * 4),
            lockedAmt,
            inv.start_date,
            inv.end_date,
            inv.last_roi_date,
            inv.status,
            inv.created_at,
          ]
        );
      }

      await conn.query(
        `UPDATE investments
         SET token_amount = ?, total_return = ?, locked_amount = 0, sellable_amount = ?
         WHERE id = ?`,
        [flexAmt, roundXit(flexAmt * 3), sellable, inv.id]
      );

      created += 1;
      console.log(
        `split inv=${inv.id} user=${inv.user_id} flex=${flexAmt} lock=${lockedAmt} sellable=${sellable} roi_kept=${inv.roi_received}`
      );
    }

    await conn.commit();
    console.log(`Done. Created ${created} Flexible Lock rows.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
