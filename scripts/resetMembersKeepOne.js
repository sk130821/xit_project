import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

/**
 * Deletes all members except one root tester.
 * Keeps that member's investments, transactions, and wallet data.
 * Clears payout history and referral tree for a fresh MLM test chain.
 *
 * Env:
 *   KEEP_USER_EMAIL — member to keep (default: SEED_USER_EMAIL or m@gmail.com)
 */
async function resetMembersKeepOne() {
  const keepEmail = (process.env.KEEP_USER_EMAIL || process.env.SEED_USER_EMAIL || 'm@gmail.com').toLowerCase();

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'xit_token',
  });

  try {
    await connection.beginTransaction();

    const [keepers] = await connection.query(
      'SELECT id, username, email, referral_code, is_active FROM users WHERE email = ?',
      [keepEmail]
    );

    if (keepers.length === 0) {
      throw new Error(`Keeper user not found: ${keepEmail}. Create this user first or set KEEP_USER_EMAIL.`);
    }

    const keeper = keepers[0];
    const keeperId = keeper.id;

    const [allUsers] = await connection.query('SELECT id, email FROM users');
    const deleteIds = allUsers.filter((u) => u.id !== keeperId).map((u) => u.id);

    const [invBefore] = await connection.query(
      'SELECT COUNT(*) AS c FROM investments WHERE user_id = ?',
      [keeperId]
    );
    const investmentCount = Number(invBefore[0].c);

    await connection.query('DELETE FROM payout_runs');

    await connection.query('UPDATE users SET sponsor_id = NULL WHERE id = ?', [keeperId]);
    await connection.query('DELETE FROM referral_relations WHERE user_id = ?', [keeperId]);

    if (deleteIds.length > 0) {
      const placeholders = deleteIds.map(() => '?').join(',');
      await connection.query(`DELETE FROM users WHERE id IN (${placeholders})`, deleteIds);
    }

    await connection.query('UPDATE users SET is_active = 1 WHERE id = ?', [keeperId]);

    const demoUsdt = parseFloat(process.env.KEEP_USER_USDT || process.env.SEED_USER_BALANCE || '1000');
    await connection.query(
      'UPDATE users SET wallet_balance = GREATEST(wallet_balance, ?) WHERE id = ?',
      [demoUsdt, keeperId]
    );

    const [invAfter] = await connection.query(
      'SELECT id, plan_type, token_amount, status FROM investments WHERE user_id = ?',
      [keeperId]
    );

    const [remaining] = await connection.query('SELECT COUNT(*) AS c FROM users');
    const [txCount] = await connection.query(
      'SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?',
      [keeperId]
    );

    await connection.commit();

    console.log('Member reset complete.');
    console.log('-----------------------------');
    console.log(`Deleted members:     ${deleteIds.length}`);
    console.log(`Remaining members:   ${remaining[0].c}`);
    console.log(`Keeper:              ${keeper.username} (${keeper.email})`);
    console.log(`Referral code:       ${keeper.referral_code}`);
    console.log(`Investments kept:    ${invAfter.length} (was ${investmentCount} before cleanup)`);
    invAfter.forEach((inv) => {
      console.log(`  - #${inv.id} ${inv.plan_type} ${Number(inv.token_amount)} XIT (${inv.status})`);
    });
    console.log(`Keeper transactions: ${txCount[0].c}`);
    console.log(`Payout runs:         cleared`);
    console.log('');
    console.log('Use this referral link for new test signups:');
    console.log(`  https://xit.virajnandanigold.com/?ref=${keeper.referral_code}`);
    console.log(`  (local: http://localhost:5173/?ref=${keeper.referral_code})`);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    await connection.end();
  }
}

resetMembersKeepOne().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
