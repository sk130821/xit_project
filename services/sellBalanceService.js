/**
 * Sellable balance rules:
 * - Flexible plan: sellable_amount (80%) while active
 * - Lock plan ROI: non-sellable until 3X complete; then sellable_amount = roi_received
 * - Other wallet income (flex ROI, level bonus): sellable unless held by active lock ROI
 */

export async function getInvestmentBalanceStats(conn, userId) {
  const [rows] = await conn.query(
    `SELECT
      COALESCE(SUM(sellable_amount), 0) AS plan_sellable,
      COALESCE(SUM(CASE WHEN status = 'active' THEN locked_amount ELSE 0 END), 0) AS plan_locked,
      COALESCE(SUM(
        CASE WHEN status = 'active' AND plan_type = 'lock' THEN roi_received ELSE 0 END
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

export function computeMemberSellable(walletBalance, planSellable, planLocked, lockRoiHeld) {
  const balance = Number(walletBalance) || 0;
  const sellable = Number(planSellable) || 0;
  const locked = Number(planLocked) || 0;
  const lockHeld = Number(lockRoiHeld) || 0;

  const incomeSellable = Math.max(0, balance - locked - lockHeld);
  const totalSellable = Math.min(balance, sellable + incomeSellable);

  return {
    totalSellable,
    incomeSellable,
    lockRoiHeld: lockHeld,
    planSellable: sellable,
    planLocked: locked,
  };
}

export function investmentAllowsSell(inv) {
  const sellable = Number(inv.sellable_amount);
  if (sellable <= 0) return false;
  if (inv.status === 'active') return true;
  return inv.status === 'completed' && inv.plan_type === 'lock';
}

/** When a lock plan reaches 3X, ROI becomes sellable on that investment. */
export async function applyLockPlanCompletionSellable(conn, investmentId, planType, newStatus, roiReceived) {
  if (planType !== 'lock' || newStatus !== 'completed') return;

  const roi = Number(roiReceived) || 0;
  if (roi <= 0) return;

  await conn.query(
    'UPDATE investments SET sellable_amount = ? WHERE id = ? AND plan_type = ?',
    [roi, investmentId, 'lock']
  );
}
