/**
 * Align all members' active Flexible plans with sell ledger:
 * - Principal (token_amount) matches sellable after sells
 * - ROI cap (total_return) recalculated on remaining principal
 * - Optional: users.total_invested refreshed from active plan principals
 *
 *   node scripts/syncAllFlexiblePlans.js           # dry-run
 *   node scripts/syncAllFlexiblePlans.js --apply
 */
import '../loadEnv.js';
import { pool } from '../db.js';
import { PLAN_CONFIG, calcTotalReturn } from '../services/investmentService.js';
import {
  reconcileActiveFlexiblePrincipal,
  applyPrincipalReductionAfterSell,
} from '../services/sellBalanceService.js';
import { ensureSellOrdersTable } from '../services/sellOrderService.js';
import { getISTDateString } from '../utils/istDate.js';

const APPLY = process.argv.includes('--apply');

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

async function recalcFlexibleTotalReturn(conn, investmentId, userId) {
  const [rows] = await conn.query(
    'SELECT token_amount, roi_received, end_date, status FROM investments WHERE id = ? AND user_id = ?',
    [investmentId, userId]
  );
  if (rows.length === 0) return;
  const inv = rows[0];
  const principal = Number(inv.token_amount);
  const roiReceived = Number(inv.roi_received);
  const plan = PLAN_CONFIG.flexible;

  let newTotalReturn;
  let newStatus = inv.status;
  if (principal <= 0) {
    newTotalReturn = roiReceived;
    newStatus = 'completed';
  } else {
    newTotalReturn = roundXit(roiReceived + calcTotalReturn(principal, plan));
  }

  const endDate = inv.end_date ? String(inv.end_date).slice(0, 10) : null;
  const today = getISTDateString();
  if (endDate && today >= endDate && principal > 0) {
    newStatus = 'completed';
  }

  await conn.query(
    'UPDATE investments SET total_return = ?, status = ? WHERE id = ? AND user_id = ?',
    [newTotalReturn, newStatus, investmentId, userId]
  );
}

async function loadSoldByInvestment(conn, userId) {
  const [rows] = await conn.query(
    `SELECT investment_id, COALESCE(SUM(amount_from_investments), 0) AS sold
     FROM sell_orders
     WHERE user_id = ? AND investment_id IS NOT NULL
     GROUP BY investment_id`,
    [userId]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.investment_id), roundXit(Number(r.sold)));
  }
  return map;
}

async function applyTargetFlexibleRow(conn, userId, invId, target, changes, label) {
  const [rows] = await conn.query(
    'SELECT token_amount, sellable_amount FROM investments WHERE id = ? AND user_id = ?',
    [invId, userId]
  );
  if (rows.length === 0) return;
  const before = {
    principal: roundXit(Number(rows[0].token_amount)),
    sellable: roundXit(Number(rows[0].sellable_amount)),
  };
  if (Math.abs(before.principal - target) < 1e-8 && Math.abs(before.sellable - target) < 1e-8) {
    return;
  }
  changes.push({
    invId,
    action: label,
    before,
    after: { principal: target, sellable: target },
  });
  if (APPLY) {
    await conn.query(
      'UPDATE investments SET token_amount = ?, sellable_amount = ? WHERE id = ? AND user_id = ?',
      [target, target, invId, userId]
    );
    await recalcFlexibleTotalReturn(conn, invId, userId);
  }
}

async function syncUserFlexible(conn, userId, username) {
  const changes = [];
  const soldByInv = await loadSoldByInvestment(conn, userId);

  await reconcileActiveFlexiblePrincipal(conn, userId);

  const [flexRows] = await conn.query(
    `SELECT id, token_amount, sellable_amount, locked_amount
     FROM investments WHERE user_id = ? AND plan_type = 'flexible' AND status = 'active'
     ORDER BY id FOR UPDATE`,
    [userId]
  );

  for (const inv of flexRows) {
    let principal = roundXit(Number(inv.token_amount));
    let sellable = roundXit(Number(inv.sellable_amount));

    if (sellable > principal + 1e-8) {
      changes.push({
        invId: inv.id,
        action: 'cap_sellable',
        before: { principal, sellable },
        after: { principal, sellable: principal },
      });
      if (APPLY) {
        await conn.query(
          'UPDATE investments SET sellable_amount = ? WHERE id = ? AND user_id = ?',
          [principal, inv.id, userId]
        );
      }
      sellable = principal;
    }

    const gap = roundXit(principal - sellable);
    if (gap > 1e-8) {
      changes.push({
        invId: inv.id,
        action: 'reduce_principal',
        before: { principal, sellable },
        after: { principal: sellable, sellable },
      });
      if (APPLY) {
        await applyPrincipalReductionAfterSell(conn, inv.id, userId, gap);
      }
    }

    if (Number(inv.locked_amount) > 0) {
      changes.push({
        invId: inv.id,
        action: 'clear_flex_locked_amount',
        locked: Number(inv.locked_amount),
      });
      if (APPLY) {
        await conn.query(
          'UPDATE investments SET locked_amount = 0 WHERE id = ? AND user_id = ?',
          [inv.id, userId]
        );
      }
    }

    if (APPLY) {
      await recalcFlexibleTotalReturn(conn, inv.id, userId);
    }
  }

  // Rebuild from sell_orders: original flex slice − sold on that investment
  const [flexRows2] = await conn.query(
    `SELECT id, token_amount, sellable_amount FROM investments
     WHERE user_id = ? AND plan_type = 'flexible' AND status = 'active'
     ORDER BY id FOR UPDATE`,
    [userId]
  );

  for (const inv of flexRows2) {
    const sold = soldByInv.get(inv.id) || 0;
    const token = roundXit(Number(inv.token_amount));
    const sellable = roundXit(Number(inv.sellable_amount));
    if (sold <= 0) continue;

    const original = roundXit(Math.max(token, sellable + sold));
    const target = roundXit(Math.max(0, original - sold));
    await applyTargetFlexibleRow(conn, userId, inv.id, target, changes, 'rebuild_from_sell_orders');
  }

  // Note: sell_orders without investment_id are NOT re-applied here — ledger may already reflect them.

  const [soldRow] = await conn.query(
    `SELECT COALESCE(SUM(amount_from_investments), 0) AS sold
     FROM sell_orders WHERE user_id = ?`,
    [userId]
  );
  const soldFromPlan = Number(soldRow[0]?.sold || 0);

  const [sumRow] = await conn.query(
    `SELECT
       COALESCE(SUM(CASE WHEN plan_type = 'flexible' AND status = 'active' THEN token_amount ELSE 0 END), 0) AS flex_tokens,
       COALESCE(SUM(CASE WHEN plan_type = 'flexible' AND status = 'active' THEN sellable_amount ELSE 0 END), 0) AS flex_sellable
     FROM investments WHERE user_id = ?`,
    [userId]
  );
  const flexTokens = Number(sumRow[0].flex_tokens);
  const flexSellable = Number(sumRow[0].flex_sellable);

  if (APPLY) {
    const [invSum] = await conn.query(
      `SELECT COALESCE(SUM(token_amount), 0) AS t
       FROM investments WHERE user_id = ? AND status = 'active'
         AND plan_type IN ('flexible', 'flexible_lock', 'lock')`,
      [userId]
    );
    await conn.query('UPDATE users SET total_invested = ? WHERE id = ?', [
      roundXit(Number(invSum[0].t)),
      userId,
    ]);
  }

  return {
    username,
    userId,
    soldFromPlan,
    flexTokens,
    flexSellable,
    changes,
  };
}

async function main() {
  await ensureSellOrdersTable(pool);
  const conn = await pool.getConnection();
  const reports = [];
  let usersTouched = 0;

  try {
    const [users] = await conn.query(
      `SELECT DISTINCT u.id, u.username
       FROM users u
       INNER JOIN investments i ON i.user_id = u.id AND i.plan_type = 'flexible'
       ORDER BY u.id`
    );

    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | Flexible members: ${users.length}\n`);

    for (const u of users) {
      if (APPLY) {
        await conn.beginTransaction();
      }
      try {
        const report = await syncUserFlexible(conn, u.id, u.username);
        if (report.changes.length > 0) {
          usersTouched += 1;
          reports.push(report);
          console.log(`--- ${report.username} (id=${report.userId}) ---`);
          console.log(
            `  flex token=${report.flexTokens} sellable=${report.flexSellable} | sell_orders plan sold=${report.soldFromPlan}`
          );
          for (const c of report.changes) {
            console.log(`  inv#${c.invId} ${c.action}`, c.before ? `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}` : c.locked ?? '');
          }
        }
        if (APPLY) {
          await conn.commit();
        }
      } catch (err) {
        if (APPLY) {
          await conn.rollback();
        }
        console.error(`FAILED user ${u.username}:`, err.message);
      }
    }

    console.log(`\nDone. Users with changes: ${usersTouched}${APPLY ? ' (committed)' : ' (dry-run only)'}`);
    if (!APPLY) {
      console.log('Run with --apply to write fixes.');
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
