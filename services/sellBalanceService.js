/**
 * Sellable = Flexible + Flexible ROI + Referral + Level + Reward
 *
 * Token sells are not subtracted from this total.
 * Not included: Lock, Flexible Lock, and their ROI until 4X + end_date.
 */

import { PLAN_CONFIG, calcTotalReturn } from './investmentService.js';
import { getISTDateString } from '../utils/istDate.js';

/** Bonuses that count in Sellable (matches dashboard cards). */
export const SELLABLE_BONUS_INCOME_TYPES = [
  'referral_bonus',
  'level_bonus',
  'reward_bonus',
];

/** Wallet income types (excludes plan ROI tx; flex ROI uses investments.roi_received). */
export const WALLET_BONUS_INCOME_TYPES = [
  ...SELLABLE_BONUS_INCOME_TYPES,
  'commission',
  'admin_grant',
];

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

/** @typedef {{ referral: number; level: number; reward: number; flexibleRoi: number }} IncomeAvailability */

/**
 * Sellable = Flexible + available Flexible ROI + available Referral + Level + Reward
 */
export function composeMemberSellable(flexiblePrincipal, available) {
  const plan = roundXit(Number(flexiblePrincipal) || 0);
  const flexRoi = roundXit(Number(available?.flexibleRoi) || 0);
  const referral = roundXit(Number(available?.referral) || 0);
  const level = roundXit(Number(available?.level) || 0);
  const reward = roundXit(Number(available?.reward) || 0);
  const other = roundXit(referral + level + reward);
  const income = roundXit(flexRoi + other);
  return {
    totalSellable: roundXit(plan + income),
    incomeSellable: income,
    otherIncomeSellable: other,
    flexibleRoiSellable: flexRoi,
    planSellable: plan,
    bonusIncomeTotal: other,
    ledgerIncomeTotal: income,
    walletSellable: income,
    flexRoiCap: flexRoi,
    otherIncomeCap: other,
    availableIncome: {
      flexibleRoi: flexRoi,
      referral,
      level,
      reward,
    },
  };
}

export async function sumIncomeTotalsByType(conn, userId) {
  const [flexRoiRows] = await conn.query(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     INNER JOIN investments i ON i.id = t.investment_id
     WHERE t.user_id = ? AND t.type = 'roi' AND i.plan_type = 'flexible'`,
    [userId]
  );
  const [bonusRows] = await conn.query(
    `SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = ? AND type IN (?)
     GROUP BY type`,
    [userId, SELLABLE_BONUS_INCOME_TYPES]
  );
  const bonusMap = Object.fromEntries(bonusRows.map((r) => [r.type, Number(r.total)]));
  return {
    flexibleRoi: roundXit(Number(flexRoiRows[0].total)),
    referral: roundXit(bonusMap.referral_bonus || 0),
    level: roundXit(bonusMap.level_bonus || 0),
    reward: roundXit(bonusMap.reward_bonus || 0),
  };
}

export async function sumSoldBonusAllocations(conn, userId) {
  try {
    const [rows] = await conn.query(
      `SELECT
        COALESCE(SUM(from_referral), 0) AS referral,
        COALESCE(SUM(from_level), 0) AS level,
        COALESCE(SUM(from_reward), 0) AS reward,
        COALESCE(SUM(from_flexible_roi), 0) AS flexible_roi,
        COALESCE(SUM(from_flexible_principal), 0) AS flexible_principal
       FROM sell_income_allocations WHERE user_id = ?`,
      [userId]
    );
    return {
      referral: roundXit(Number(rows[0].referral)),
      level: roundXit(Number(rows[0].level)),
      reward: roundXit(Number(rows[0].reward)),
      flexibleRoi: roundXit(Number(rows[0].flexible_roi)),
      flexiblePrincipal: roundXit(Number(rows[0].flexible_principal)),
    };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return { referral: 0, level: 0, reward: 0, flexibleRoi: 0, flexiblePrincipal: 0 };
    }
    throw err;
  }
}

/** Referral → Level → Reward (matches sell deduction order). */
export function splitBonusSellAmount(amount, available) {
  let rem = roundXit(Number(amount) || 0);
  const fromReferral = roundXit(Math.min(rem, Math.max(0, Number(available.referral) || 0)));
  rem = roundXit(rem - fromReferral);
  const fromLevel = roundXit(Math.min(rem, Math.max(0, Number(available.level) || 0)));
  rem = roundXit(rem - fromLevel);
  const fromReward = roundXit(Math.min(rem, Math.max(0, Number(available.reward) || 0)));
  return { fromReferral, fromLevel, fromReward };
}

export async function getMemberSellableBreakdown(conn, userId) {
  const stats = await getInvestmentBalanceStats(conn, userId);
  const totals = await sumIncomeTotalsByType(conn, userId);
  const soldBonus = await sumSoldBonusAllocations(conn, userId);

  const available = {
    flexibleRoi: roundXit(stats.flexibleRoi),
    referral: roundXit(Math.max(0, totals.referral - soldBonus.referral)),
    level: roundXit(Math.max(0, totals.level - soldBonus.level)),
    reward: roundXit(Math.max(0, totals.reward - soldBonus.reward)),
  };

  const composed = composeMemberSellable(stats.planSellable, available);

  return {
    ...composed,
    incomeTotals: {
      flexibleRoi: totals.flexibleRoi,
      referral: totals.referral,
      level: totals.level,
      reward: totals.reward,
    },
    incomeAvailable: available,
    planLocked: stats.planLocked,
    lockRoiHeld: stats.lockRoiHeld,
  };
}

export async function sumSellableBonusLedger(conn, userId) {
  const totals = await sumIncomeTotalsByType(conn, userId);
  return roundXit(totals.referral + totals.level + totals.reward);
}

/**
 * Remaining wallet income helper (legacy). Sellable itself uses composeMemberSellable, not wallet-after-sells.
 */
export function pickWalletIncomeSellable(fromWallet, ledgerIncomeTotal, sellCount = 0) {
  const ledger = ledgerIncomeTotal != null ? roundXit(Number(ledgerIncomeTotal) || 0) : null;
  if (ledger != null) return ledger;
  return roundXit(Number(fromWallet) || 0);
}

/** Tokens unlocked in a chain wallet (excludes lock / flex-lock / held lock ROI). */
export function unlockedOnChainSellable(onChainBalance, planLocked, lockRoiHeld) {
  return roundXit(
    Math.max(
      0,
      (Number(onChainBalance) || 0) - (Number(planLocked) || 0) - (Number(lockRoiHeld) || 0)
    )
  );
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

/** If sellable was reduced but flexible principal was not, sync token_amount + ROI cap. */
export async function reconcileActiveFlexiblePrincipal(conn, userId) {
  const [rows] = await conn.query(
    `SELECT id, token_amount, sellable_amount FROM investments
     WHERE user_id = ? AND plan_type = 'flexible' AND status = 'active'`,
    [userId]
  );

  for (const inv of rows) {
    const principal = Number(inv.token_amount);
    const sellable = Number(inv.sellable_amount);
    const gap = roundXit(principal - sellable);
    if (gap > 1e-8) {
      await applyPrincipalReductionAfterSell(conn, inv.id, userId, gap);
    }
  }
}

export async function getInvestmentBalanceStats(conn, userId) {
  await unlockMaturedLockRoiSellable(conn, userId);
  await reconcileActiveFlexiblePrincipal(conn, userId);

  const today = getISTDateString();
  const [rows] = await conn.query(
    `SELECT
      COALESCE(SUM(
        CASE
          WHEN plan_type IN ('lock', 'flexible_lock') AND status = 'active' THEN 0
          ELSE sellable_amount
        END
      ), 0) AS plan_sellable,
      COALESCE(SUM(CASE WHEN status = 'active' THEN locked_amount ELSE 0 END), 0) AS plan_locked,
      COALESCE(SUM(${lockRoiHeldCaseSql()}), 0) AS lock_roi_held,
      COALESCE(SUM(CASE WHEN plan_type = 'flexible' THEN roi_received ELSE 0 END), 0) AS flexible_roi
     FROM investments WHERE user_id = ?`,
    [today, userId]
  );

  return {
    planSellable: Number(rows[0].plan_sellable),
    planLocked: Number(rows[0].plan_locked),
    lockRoiHeld: Number(rows[0].lock_roi_held),
    flexibleRoi: Number(rows[0].flexible_roi),
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

/** Partition wallet into referral/level/… vs flexible ROI (both exclude lock_roi_held). */
export function computeWalletIncomeCaps(
  walletBalance,
  lockRoiHeld,
  flexibleRoi,
  ledgerIncomeTotal = null,
  subtractPlanSellable = 0,
  subtractPlanLocked = 0,
  sellCount = 0
) {
  const planOffset = roundXit(Number(subtractPlanSellable) || 0);
  const lockedOffset = roundXit(Number(subtractPlanLocked) || 0);
  const fromWallet = roundXit(
    Math.max(
      0,
      (Number(walletBalance) || 0) - (Number(lockRoiHeld) || 0) - planOffset - lockedOffset
    )
  );
  const flexTracked = roundXit(Number(flexibleRoi) || 0);
  const ledger = ledgerIncomeTotal != null ? roundXit(Number(ledgerIncomeTotal)) : null;
  const walletSellable = pickWalletIncomeSellable(fromWallet, ledger, sellCount);
  const flexRoiCap = roundXit(Math.min(flexTracked, walletSellable));
  const otherIncomeCap = roundXit(Math.max(0, walletSellable - flexRoiCap));
  return { walletSellable, flexRoiCap, otherIncomeCap, fromWallet, ledgerIncomeTotal: ledger };
}

/** Sum recorded bonus income + flexible ROI (legacy members if xit_balance was not synced). */
export async function sumLegacyWalletIncomeLedger(conn, userId, flexibleRoi) {
  const [tx] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = ? AND type IN (?)`,
    [userId, WALLET_BONUS_INCOME_TYPES]
  );
  const bonusTotal = roundXit(Number(tx[0].total));
  const flex = roundXit(Number(flexibleRoi) || 0);
  return {
    bonusTotal,
    ledgerIncomeTotal: roundXit(bonusTotal + flex),
  };
}

export async function computeWalletIncomeSellableCaps(
  conn,
  userId,
  xitBalance,
  lockRoiHeld,
  flexibleRoi,
  subtractPlanSellable = 0,
  subtractPlanLocked = 0
) {
  const breakdown = await getMemberSellableBreakdown(conn, userId);
  const caps = computeWalletIncomeCaps(
    xitBalance,
    lockRoiHeld,
    flexibleRoi,
    breakdown.ledgerIncomeTotal,
    subtractPlanSellable,
    subtractPlanLocked,
    0
  );
  return {
    ...caps,
    walletSellable: breakdown.incomeSellable,
    flexRoiCap: breakdown.flexibleRoiSellable,
    otherIncomeCap: breakdown.otherIncomeSellable,
    availableIncome: breakdown.incomeAvailable,
    bonusTotal: breakdown.bonusIncomeTotal,
    ledgerIncomeTotal: breakdown.ledgerIncomeTotal,
    sellCount: 0,
  };
}

/** Sync xit_balance when old accounts have income in transactions but wallet was never credited. */
export async function reconcileLegacyXitBalance(conn, userId, lockRoiHeld, flexibleRoi) {
  const [rows] = await conn.query('SELECT xit_balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!rows.length) return 0;
  const current = Number(rows[0].xit_balance || 0);
  const { ledgerIncomeTotal } = await sumLegacyWalletIncomeLedger(conn, userId, flexibleRoi);
  if (ledgerIncomeTotal <= current + 1e-8) return current;

  const [sellRows] = await conn.query(
    "SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'sell'",
    [userId]
  );
  const sellCount = Number(sellRows[0].c);
  if (sellCount === 0) {
    await conn.query('UPDATE users SET xit_balance = ? WHERE id = ?', [ledgerIncomeTotal, userId]);
    return ledgerIncomeTotal;
  }
  return current;
}

export function memberSellableViewFromCaps(planSellable, caps, _unlockedCap = null) {
  const composed = composeMemberSellable(planSellable, {
    flexibleRoi: caps.flexibleRoiSellable ?? caps.flexRoiCap ?? 0,
    referral: caps.availableIncome?.referral ?? caps.otherIncomeCap ?? 0,
    level: caps.availableIncome?.level ?? 0,
    reward: caps.availableIncome?.reward ?? 0,
  });
  return {
    ...composed,
    bonusIncomeTotal: caps.bonusTotal ?? composed.bonusIncomeTotal,
    ledgerIncomeTotal: caps.ledgerIncomeTotal ?? composed.ledgerIncomeTotal,
  };
}

/** Member sellable: plan slices + all sellable wallet income (not lock / flex-lock held ROI). */
export function computeMemberFlexAwareSellable(planSellable, flexibleRoi, walletBalance, lockRoiHeld = 0) {
  const caps = computeWalletIncomeCaps(walletBalance, lockRoiHeld, flexibleRoi);
  return memberSellableViewFromCaps(planSellable, caps);
}

export async function computeDemoMemberSellable(conn, userId, _planSellable, _flexibleRoi, _xitBalance, _lockRoiHeld) {
  return getMemberSellableBreakdown(conn, userId);
}

/** Blockchain sellable uses the same available-income formula as demo. */
export async function computeChainMemberSellableForUser(
  conn,
  userId,
  _onChainBalance,
  _planSellable,
  _planLocked,
  _lockRoiHeld,
  _flexibleRoi
) {
  return getMemberSellableBreakdown(conn, userId);
}

/** @deprecated Use computeMemberFlexAwareSellable */
export function computePlanOnlyMemberSellable(planSellable) {
  return computeMemberFlexAwareSellable(planSellable, 0, 0, 0);
}

let sellIncomeAllocTableReady = false;

export async function ensureSellIncomeAllocationsTable(conn) {
  if (sellIncomeAllocTableReady) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS sell_income_allocations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      sell_order_id INT DEFAULT NULL,
      transaction_id INT DEFAULT NULL,
      from_referral DECIMAL(20,8) NOT NULL DEFAULT 0,
      from_level DECIMAL(20,8) NOT NULL DEFAULT 0,
      from_reward DECIMAL(20,8) NOT NULL DEFAULT 0,
      from_flexible_roi DECIMAL(20,8) NOT NULL DEFAULT 0,
      from_flexible_principal DECIMAL(20,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sia_user (user_id),
      INDEX idx_sia_sell_order (sell_order_id),
      INDEX idx_sia_tx (transaction_id)
    )
  `);
  sellIncomeAllocTableReady = true;
}

export async function recordSellIncomeAllocation(conn, payload) {
  await ensureSellIncomeAllocationsTable(conn);
  await conn.query(
    `INSERT INTO sell_income_allocations (
      user_id, sell_order_id, transaction_id,
      from_referral, from_level, from_reward, from_flexible_roi, from_flexible_principal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.userId,
      payload.sellOrderId ?? null,
      payload.transactionId ?? null,
      roundXit(payload.fromReferral),
      roundXit(payload.fromLevel),
      roundXit(payload.fromReward),
      roundXit(payload.fromFlexibleRoi),
      roundXit(payload.fromFlexiblePrincipal),
    ]
  );
}

/** Split sell: other income → flexible ROI → plan. */
export function allocateSellAmountThreeTier(tokenAmount, planCap, flexRoiCap, otherIncomeCap) {
  const amount = Number(tokenAmount) || 0;
  const plan = Math.max(0, Number(planCap) || 0);
  const flex = Math.max(0, Number(flexRoiCap) || 0);
  const other = Math.max(0, Number(otherIncomeCap) || 0);
  const fromOtherIncome = roundXit(Math.min(amount, other));
  const afterOther = Math.max(0, amount - fromOtherIncome);
  const fromFlexRoi = roundXit(Math.min(afterOther, flex));
  const afterFlex = Math.max(0, afterOther - fromFlexRoi);
  const fromPlan = roundXit(Math.min(afterFlex, plan));
  const amountFromXitBalance = roundXit(fromOtherIncome + fromFlexRoi);
  return {
    amountFromOtherIncome: fromOtherIncome,
    amountFromFlexRoi: fromFlexRoi,
    amountFromInvestments: fromPlan,
    amountFromXitBalance,
  };
}

/** @deprecated Use allocateSellAmountThreeTier */
export function allocateSellAmount(tokenAmount, planSellableCap, flexibleRoiCap) {
  return allocateSellAmountThreeTier(tokenAmount, planSellableCap, flexibleRoiCap, 0);
}

/** Reduce flexible plan ROI counters when member sells credited ROI (FIFO across flexible rows). */
export async function deductFlexibleRoiReceived(conn, userId, amount, specificInvestmentId = null) {
  let remainder = roundXit(Number(amount) || 0);
  if (remainder <= 0) return;

  if (specificInvestmentId) {
    const id = Number(specificInvestmentId);
    const [rows] = await conn.query(
      `SELECT id, roi_received FROM investments
       WHERE id = ? AND user_id = ? AND plan_type = 'flexible' FOR UPDATE`,
      [id, userId]
    );
    if (rows.length === 0) throw new Error('Flexible investment not found for ROI deduction');
    const available = roundXit(Number(rows[0].roi_received));
    if (remainder > available + 1e-8) {
      throw new Error('Insufficient flexible ROI on this investment');
    }
    await conn.query(
      'UPDATE investments SET roi_received = GREATEST(0, roi_received - ?) WHERE id = ? AND user_id = ?',
      [remainder, id, userId]
    );
    return;
  }

  while (remainder > 1e-8) {
    const [invs] = await conn.query(
      `SELECT id, roi_received FROM investments
       WHERE user_id = ? AND plan_type = 'flexible' AND roi_received > 0
       ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [userId]
    );
    if (invs.length === 0) {
      throw new Error('Insufficient flexible ROI to complete sell');
    }
    const inv = invs[0];
    const available = roundXit(Number(inv.roi_received));
    const slice = roundXit(Math.min(remainder, available));
    await conn.query(
      'UPDATE investments SET roi_received = GREATEST(0, roi_received - ?) WHERE id = ? AND user_id = ?',
      [slice, inv.id, userId]
    );
    remainder = roundXit(remainder - slice);
  }
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
