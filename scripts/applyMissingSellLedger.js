/**
 * Apply plan ledger for a completed sell tx that has transactions row but no sell_orders / no investment cut.
 *
 *   node scripts/applyMissingSellLedger.js <xit_tx_hash>           # dry-run
 *   node scripts/applyMissingSellLedger.js <xit_tx_hash> --apply
 */
import '../loadEnv.js';
import { pool } from '../db.js';
import { applySellLedger } from '../services/sellOrderService.js';
import { getInvestmentBalanceStats } from '../services/sellBalanceService.js';

const APPLY = process.argv.includes('--apply');
const hashArg = process.argv.find((a) => a.startsWith('0x'));

if (!hashArg || !/^0x[a-fA-F0-9]{64}$/.test(hashArg)) {
  console.error('Usage: node scripts/applyMissingSellLedger.js 0x<64-hex> [--apply]');
  process.exit(1);
}

const txHash = hashArg.toLowerCase();

function parseSoldXit(description) {
  const m = String(description || '').match(/Sold\s+([\d.]+)\s+XIT/i);
  return m ? Number(m[1]) : null;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    const [txRows] = await conn.query(
      "SELECT * FROM transactions WHERE type = 'sell' AND LOWER(tx_hash) = ? LIMIT 1",
      [txHash]
    );
    if (txRows.length === 0) {
      console.error('No sell transaction found for hash:', txHash);
      process.exit(1);
    }
    const tx = txRows[0];
    const userId = tx.user_id;
    const tokenAmount = parseSoldXit(tx.description);
    if (!tokenAmount || tokenAmount <= 0) {
      console.error('Could not parse sold XIT from description:', tx.description);
      process.exit(1);
    }

    const [existing] = await conn.query('SELECT id FROM sell_orders WHERE LOWER(xit_tx_hash) = ?', [txHash]);
    if (existing.length > 0) {
      console.error('sell_orders row already exists — use compensation flow instead.');
      process.exit(1);
    }

    const before = await getInvestmentBalanceStats(conn, userId);
    const [flexBefore] = await conn.query(
      `SELECT id, token_amount, sellable_amount FROM investments
       WHERE user_id = ? AND plan_type = 'flexible' ORDER BY id`,
      [userId]
    );

    console.log('User id:', userId);
    console.log('Sold XIT (from tx):', tokenAmount);
    console.log('Plan sellable before:', before.planSellable);
    console.log('Flexible rows before:', flexBefore);

    if (!APPLY) {
      console.log('\nDry-run — would apply sell ledger: amountFromInvestments =', tokenAmount);
      console.log('Run with --apply to commit.');
      return;
    }

    await conn.beginTransaction();
    await applySellLedger(conn, {
      userId,
      amountFromXitBalance: 0,
      amountFromInvestments: tokenAmount,
      targetInvestmentId: null,
      chainMode: true,
    });

    const [flexAfter] = await conn.query(
      `SELECT id, token_amount, sellable_amount FROM investments
       WHERE user_id = ? AND plan_type = 'flexible' ORDER BY id`,
      [userId]
    );

    await conn.commit();

    const after = await getInvestmentBalanceStats(pool, userId);
    console.log('\nApplied.');
    console.log('Plan sellable after:', after.planSellable);
    console.log('Flexible rows after:', flexAfter);
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
