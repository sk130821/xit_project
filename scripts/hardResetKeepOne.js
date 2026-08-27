import '../loadEnv.js';
import { pool } from '../db.js';

const KEEP_EMAIL = (process.env.KEEP_USER_EMAIL || 'sponsor@xit.com').toLowerCase();
const USDT = parseFloat(process.env.KEEP_USER_USDT || '10000');

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [keepers] = await conn.query('SELECT id, username, email, referral_code FROM users WHERE email = ?', [
    KEEP_EMAIL,
  ]);
  if (keepers.length === 0) throw new Error(`Keeper not found: ${KEEP_EMAIL}`);
  const keeper = keepers[0];
  const kid = keeper.id;

  // Wipe all activity tables (FK may be missing on dumped DBs)
  const [dTx] = await conn.query('DELETE FROM transactions');
  const [dInv] = await conn.query('DELETE FROM investments');
  const [dRef] = await conn.query('DELETE FROM referral_relations');
  const [dPay] = await conn.query('DELETE FROM payout_runs');
  try {
    await conn.query('DELETE FROM password_reset_tokens');
  } catch {
    /* optional table */
  }

  await conn.query(
    `UPDATE users SET
       sponsor_id = NULL,
       wallet_balance = ?,
       xit_balance = 0,
       total_earned = 0,
       total_invested = 0,
       total_purchased = 0,
       is_active = 1
     WHERE id = ?`,
    [USDT, kid]
  );

  const [dUsers] = await conn.query('DELETE FROM users WHERE id <> ?', [kid]);

  await conn.commit();

  console.log('Hard reset complete');
  console.log({
    keeper: `${keeper.username} <${keeper.email}> id=${kid}`,
    referral_code: keeper.referral_code,
    deletedTransactions: dTx.affectedRows,
    deletedInvestments: dInv.affectedRows,
    deletedReferralRelations: dRef.affectedRows,
    deletedPayoutRuns: dPay.affectedRows,
    deletedOtherUsers: dUsers.affectedRows,
    usdt: USDT,
  });
  console.log(`Ref link: https://xittoken.co/?ref=${keeper.referral_code}`);
  console.log(`Local:    http://localhost:5173/?ref=${keeper.referral_code}`);
} catch (err) {
  await conn.rollback();
  console.error('Hard reset failed:', err.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
