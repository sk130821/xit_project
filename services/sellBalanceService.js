/**
 * Sellable balance rules:
 * - Flexible plan: sellable_amount (80% slice) while active; ROI base = token_amount (principal)
 * - Lock / Flexible Lock ROI: non-sellable until 4X complete AND lock end_date; held in lock_roi_held
 * - Other wallet income (flex ROI, level bonus): sellable unless held by lock ROI
 *
 * walletBalance meaning:
 * - Blockchain (fullInventory): on-chain XIT already includes plan tokens + income
 * - Demo: users.xit_balance is free/income only (plan tokens live on investments)
 */

import { PLAN_CONFIG, calcTotalReturn } from './investmentService.js';
import { getISTDateString } from '../utils/istDate.js';

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

/** Lock / Flexible Lock ROI credited to wallet stays non-sellable until end_date (e.g. 1 year). */
function lockRoiHeldCaseSql() {
  return `CASE WHEN plan_type IN ('lock', 'flexible_lock') AND roi_received > 0
      AND (
        status = 'active'
        OR (status = 'completed' AND DATE(end_date) > ?)
      )
    THEN roi_received ELSE 0 END`;
}

/** After lock period, move completed lock ROI to investment sellable_amount. */
export async function unlockMaturedLockRoiSellable(conn, userId) {
  const today = getISTDateString();
  await conn.query(
    `UPDATE investments
     SET sellable_amount = roi_received
     WHERE user_id = ?
       AND plan_type IN ('lock', 'flexible_lock')
       AND status = 'completed'
       AND roi_received > 0
       AND DATE(end_date) <= ?
       AND sellable_amount < roi_received`,
    [userId, today]
  );
}

export async function getInvestmentBalanceStats(conn, userId) {
  await unlockMaturedLockRoiSellable(conn, userId);

  const today = getISTDateString();
  const [rows] = await conn.query(
    `SELECT
      COALESCE(SUM(sellable_amount), 0) AS plan_sellable,
      COALESCE(SUM(CASE WHEN status = 'active' THEN locked_amount ELSE 0 END), 0) AS plan_locked,
      COALESCE(SUM(${lockRoiHeldCaseSql()}), 0) AS lock_roi_held
     FROM investments WHERE user_id = ?`,
    [today, userId]
  );

  return {
    planSellable: Number(rows[0].plan_sellable),
    planLocked: Number(rows[0].plan_locked),
    lockRoiHeld: Number(rows[0].lock_roi_held),
  };
}

export function computeMemberSellable(walletBalance, planSellable, planLocked, lockRoiHeld, options = {}) {
  const balance = Number(walletBalance) || 0;
  const sellable = Number(planSellable) || 0;
  const locked = Number(planLocked) || 0;
  const lockHeld = Number(lockRoiHeld) || 0;
  const fullInventory = options === true || options.fullInventory === true;

  let incomeSellable;
  let totalSellable;

  if (fullInventory) {
    const afterHold = Math.max(0, balance - locked - lockHeld);
    incomeSellable = Math.max(0, afterHold - sellable);
    totalSellable = Math.min(balance, afterHold);
  } else {
    incomeSellable = Math.max(0, balance - lockHeld);
    totalSellable = sellable + incomeSellable;
  }

  return {
    totalSellable: roundXit(totalSellable),
    incomeSellable: roundXit(incomeSellable),
    lockRoiHeld: lockHeld,
    planSellable: sellable,
    planLocked: locked,
  };
}

export function investmentAllowsSell(inv) {
  const sellable = Number(inv.sellable_amount);
  if (sellable <= 0) return false;
  if (inv.status === 'active') return true;
  if (inv.status !== 'completed' || (inv.plan_type !== 'lock' && inv.plan_type !== 'flexible_lock')) {
    return false;
  }
  const endDate = inv.end_date ? String(inv.end_date).slice(0, 10) : null;
  const today = getISTDateString();
  return !endDate || endDate <= today;
}

/**
 * Apply sell slice to one investment row (call inside transaction after sellable_amount -= slice).
 * Flexible active: reduces token_amount + total_return (ROI base = remaining principal).
 * Lock / flexible_lock (matured ROI sell): sellable only.
 */
export async function applyPrincipalReductionAfterSell(conn, investmentId, userId, slice) {
  const amount = Number(slice);
  if (amount <= 0) return;

  const [rows] = await conn.query(
    'SELECT id, plan_type, status, token_amount, total_return, roi_received, end_date FROM investments WHERE id = ? AND user_id = ? FOR UPDATE',
    [investmentId, userId]
  );
  if (rows.length === 0) return;

  const inv = rows[0];
  if (inv.plan_type === 'flexible' && inv.status === 'active') {
    const newPrincipal = roundXit(Math.max(0, Number(inv.token_amount) - amount));
    const plan = PLAN_CONFIG.flexible;
    const roiReceived = Number(inv.roi_received);

    let newTotalReturn;
    let newStatus = inv.status;

    if (newPrincipal <= 0) {
      newTotalReturn = roiReceived;
      newStatus = 'completed';
    } else {
      const additionalCap = roundXit(calcTotalReturn(newPrincipal, plan));
      newTotalReturn = roundXit(roiReceived + additionalCap);
    }

    const endDate = inv.end_date ? String(inv.end_date).slice(0, 10) : null;
    const today = getISTDateString();
    if (endDate && today >= endDate) {
      newStatus = 'completed';
    }

    await conn.query(
      'UPDATE investments SET token_amount = ?, total_return = ?, status = ? WHERE id = ? AND user_id = ?',
      [newPrincipal, newTotalReturn, newStatus, investmentId, userId]
    );
  }
}

/** Decrease sellable on an investment and sync flexible principal when applicable. */
export async function deductInvestmentSellable(conn, investmentId, userId, slice) {
  const amount = Number(slice);
  if (amount <= 0) return;

  await conn.query(
    'UPDATE investments SET sellable_amount = GREATEST(0, sellable_amount - ?) WHERE id = ? AND user_id = ?',
    [amount, investmentId, userId]
  );
  await applyPrincipalReductionAfterSell(conn, investmentId, userId, amount);
}

/** Undo flexible principal reduction after a failed sell compensation. */
export async function restorePrincipalAfterSellCompensation(conn, investmentId, userId, slice) {
  const amount = Number(slice);
  if (amount <= 0) return;

  const [rows] = await conn.query(
    'SELECT id, plan_type, status, token_amount, total_return, roi_received, end_date FROM investments WHERE id = ? AND user_id = ? FOR UPDATE',
    [investmentId, userId]
  );
  if (rows.length === 0) return;

  const inv = rows[0];
  if (inv.plan_type !== 'flexible') return;

  const newPrincipal = roundXit(Number(inv.token_amount) + amount);
  const plan = PLAN_CONFIG.flexible;
  const roiReceived = Number(inv.roi_received);
  const additionalCap = roundXit(calcTotalReturn(newPrincipal, plan));
  const newTotalReturn = roundXit(roiReceived + additionalCap);

  let newStatus = 'active';
  const endDate = inv.end_date ? String(inv.end_date).slice(0, 10) : null;
  const today = getISTDateString();
  if (endDate && today >= endDate) {
    newStatus = 'completed';
  }

  await conn.query(
    'UPDATE investments SET token_amount = ?, total_return = ?, status = ? WHERE id = ? AND user_id = ?',
    [newPrincipal, newTotalReturn, newStatus, investmentId, userId]
  );
}

/** Increase plan sellable (and flexible principal) — inverse of deductInvestmentSellable. */
export async function restoreInvestmentSellable(conn, investmentId, userId, slice) {
  const amount = Number(slice);
  if (amount <= 0) return;

  await conn.query(
    'UPDATE investments SET sellable_amount = sellable_amount + ? WHERE id = ? AND user_id = ?',
    [amount, investmentId, userId]
  );
  await restorePrincipalAfterSellCompensation(conn, investmentId, userId, amount);
}

export async function resolveFlexibleRestoreInvestmentId(conn, userId, investmentId) {
  if (investmentId) {
    const id = Number(investmentId);
    const [rows] = await conn.query(
      'SELECT id, plan_type FROM investments WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (rows.length === 0) throw new Error('Investment not found');
    if (!['flexible', 'lock', 'flexible_lock'].includes(rows[0].plan_type)) {
      throw new Error('Invalid investment for sell restore');
    }
    return id;
  }

  const [rows] = await conn.query(
    `SELECT id FROM investments
     WHERE user_id = ? AND plan_type = 'flexible' AND status = 'active'
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId]
  );
  if (rows.length === 0) {
    throw new Error('No active flexible plan found. Specify investmentId or add a flexible plan first.');
  }
  return rows[0].id;
}

/** When a lock / Flexible Lock plan reaches cap, ROI becomes sellable only after end_date. */
export async function applyLockPlanCompletionSellable(conn, investmentId, planType, newStatus, roiReceived) {
  if ((planType !== 'lock' && planType !== 'flexible_lock') || newStatus !== 'completed') return;

  const roi = Number(roiReceived) || 0;
  if (roi <= 0) return;

  const [rows] = await conn.query('SELECT end_date FROM investments WHERE id = ?', [investmentId]);
  if (rows.length === 0) return;

  const endDate = rows[0].end_date ? String(rows[0].end_date).slice(0, 10) : null;
  const today = getISTDateString();
  if (endDate && endDate > today) {
    return;
  }

  await conn.query(
    'UPDATE investments SET sellable_amount = ? WHERE id = ? AND plan_type = ?',
    [roi, investmentId, planType]
  );
}
