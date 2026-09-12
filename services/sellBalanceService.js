/**
 * Sellable balance rules:
 * - Flexible plan: sellable_amount (80% slice) while active
 * - Lock / Flexible Lock ROI: non-sellable until 4X complete; then sellable_amount = roi_received
 * - Other wallet income (flex ROI, level bonus): sellable unless held by active lock ROI
 *
 * walletBalance meaning:
 * - Blockchain (fullInventory): on-chain XIT already includes plan tokens + income
 * - Demo: users.xit_balance is free/income only (plan tokens live on investments)
 */

export async function getInvestmentBalanceStats(conn, userId) {
  const [rows] = await conn.query(
    `SELECT
      COALESCE(SUM(sellable_amount), 0) AS plan_sellable,
      COALESCE(SUM(CASE WHEN status = 'active' THEN locked_amount ELSE 0 END), 0) AS plan_locked,
      COALESCE(SUM(
        CASE WHEN status = 'active' AND plan_type IN ('lock', 'flexible_lock') THEN roi_received ELSE 0 END
      ), 0) AS lock_roi_held
     FROM investments WHERE user_id = ?`,
    [userId]
  );

  return {
    planSellable: Number(rows[0].plan_sellable),
    planLocked: Number(rows[0].plan_locked),
    lockRoiHeld: Number(rows[0].lock_roi_held),
  };
}

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
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
    // On-chain wallet already contains plan sellable + locked + income.
    const afterHold = Math.max(0, balance - locked - lockHeld);
    incomeSellable = Math.max(0, afterHold - sellable);
    totalSellable = Math.min(balance, afterHold);
  } else {
    // Demo ledger: do not subtract planLocked — those tokens are not in xit_balance.
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
  return inv.status === 'completed' && (inv.plan_type === 'lock' || inv.plan_type === 'flexible_lock');
}

/** When a lock / Flexible Lock plan reaches 4X, ROI becomes sellable on that investment. */
export async function applyLockPlanCompletionSellable(conn, investmentId, planType, newStatus, roiReceived) {
  if ((planType !== 'lock' && planType !== 'flexible_lock') || newStatus !== 'completed') return;

  const roi = Number(roiReceived) || 0;
  if (roi <= 0) return;

  await conn.query(
    'UPDATE investments SET sellable_amount = ? WHERE id = ? AND plan_type = ?',
    [roi, investmentId, planType]
  );
}
