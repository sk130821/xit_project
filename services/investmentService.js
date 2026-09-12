import { getSetting } from './incomeService.js';

export const PLAN_CONFIG = {
  lock: { profitMultiplier: 3, dailyRoi: 0.82, sellablePercent: 0, lockedPercent: 100 },
  flexible: { profitMultiplier: 2, dailyRoi: 0.53, sellablePercent: 80, lockedPercent: 20 },
  flexible_lock: { profitMultiplier: 3, dailyRoi: 0.82, sellablePercent: 0, lockedPercent: 100 },
};

export function isRoiHoldPlan(planType) {
  return planType === 'lock' || planType === 'flexible_lock';
}

export function roiPlanLabel(planType) {
  if (planType === 'lock') return 'Lock Plan';
  if (planType === 'flexible_lock') return 'Flexible Lock';
  return 'Flexible';
}

export function formatRoiDescription(planType, extra = '') {
  const rate = planType === 'flexible' ? '0.53%' : '0.82%';
  const suffix = extra ? ` ${extra}` : '';
  return `Daily ROI — ${roiPlanLabel(planType)} (${rate})${suffix}`;
}

export function calcTotalReturn(tokenAmount, plan) {
  return tokenAmount * (1 + plan.profitMultiplier);
}

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

export async function getFlexibleMinTokens(conn) {
  return parseFloat(await getSetting(conn, 'flexible_min_tokens', '100'));
}

export function resolvePlanForPurchase(tokenAmount, planType, flexibleMin) {
  if (tokenAmount < flexibleMin) return 'lock';
  if (planType === 'flexible') return 'flexible';
  return planType === 'lock' ? 'lock' : 'lock';
}

export function isIncomeEligible(tokenAmount, flexibleMin) {
  return tokenAmount >= flexibleMin;
}

export function investmentHasIncomeEligible(inv, flexibleMin = 100) {
  if (inv.income_eligible != null) return Boolean(inv.income_eligible);
  return Number(inv.token_amount) >= flexibleMin;
}

async function insertInvestmentRow(conn, {
  userId,
  planType,
  tokenAmount,
  sellable,
  locked,
  incomeEligible,
  lockDays,
}) {
  const plan = PLAN_CONFIG[planType];
  if (!plan) throw new Error('Invalid plan type');

  const totalReturn = calcTotalReturn(tokenAmount, plan);
  const endDate = new Date(Date.now() + lockDays * 24 * 60 * 60 * 1000);

  const [invResult] = await conn.query(
    `INSERT INTO investments
      (user_id, plan_type, token_amount, total_return, daily_roi_rate, sellable_amount, locked_amount, end_date, income_eligible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, planType, tokenAmount, totalReturn, plan.dailyRoi, sellable, locked, endDate, incomeEligible]
  );

  return {
    investmentId: invResult.insertId,
    plan: planType,
    amount: tokenAmount,
    totalReturn,
    profitMultiplier: plan.profitMultiplier,
    dailyRoi: plan.dailyRoi,
    sellable,
    locked,
    incomeEligible: incomeEligible === 1,
  };
}

export async function createInvestmentForUser(conn, userId, tokenAmount, planType, options = {}) {
  const { skipWalletDeduction = false, skipTransaction = false } = options;
  const minPurchase = parseFloat(await getSetting(conn, 'min_purchase', '1'));
  const flexibleMin = await getFlexibleMinTokens(conn);

  if (!tokenAmount || tokenAmount < minPurchase) {
    throw new Error(`Minimum purchase is ${minPurchase} tokens`);
  }

  const resolvedPlan = resolvePlanForPurchase(tokenAmount, planType, flexibleMin);
  const incomeEligible = isIncomeEligible(tokenAmount, flexibleMin) ? 1 : 0;

  if (!PLAN_CONFIG[resolvedPlan]) {
    throw new Error('Invalid plan type');
  }

  const [users] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (users.length === 0) throw new Error('User not found');

  const user = users[0];
  if (!skipWalletDeduction && tokenAmount > Number(user.xit_balance || 0)) {
    throw new Error('Insufficient XIT balance');
  }

  const lockDays = parseInt(await getSetting(conn, 'lock_period_days', '365'));
  const flexLockDays = parseInt(await getSetting(conn, 'flexible_lock_days', '365'));

  if (skipWalletDeduction) {
    await conn.query(
      'UPDATE users SET total_invested = total_invested + ? WHERE id = ?',
      [tokenAmount, userId]
    );
  } else {
    await conn.query(
      'UPDATE users SET xit_balance = xit_balance - ?, total_invested = total_invested + ? WHERE id = ?',
      [tokenAmount, tokenAmount, userId]
    );
  }

  if (resolvedPlan === 'flexible') {
    const lockedAmt = roundXit(tokenAmount * 0.2);
    const flexAmt = roundXit(tokenAmount - lockedAmt);

    const flexInv = await insertInvestmentRow(conn, {
      userId,
      planType: 'flexible',
      tokenAmount: flexAmt,
      sellable: flexAmt,
      locked: 0,
      incomeEligible,
      lockDays: flexLockDays,
    });

    let flexLockInv = null;
    if (lockedAmt > 0) {
      flexLockInv = await insertInvestmentRow(conn, {
        userId,
        planType: 'flexible_lock',
        tokenAmount: lockedAmt,
        sellable: 0,
        locked: lockedAmt,
        incomeEligible,
        lockDays,
      });
    }

    if (!skipTransaction) {
      await conn.query(
        'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
        [userId, 'invest', flexAmt, 'flexible plan investment', flexInv.investmentId]
      );
      if (flexLockInv) {
        await conn.query(
          'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
          [userId, 'invest', lockedAmt, 'Flexible Lock (20% of flexible buy)', flexLockInv.investmentId]
        );
      }
    }

    return {
      ...flexInv,
      amount: tokenAmount,
      sellable: flexAmt,
      locked: lockedAmt,
      flexibleLockInvestmentId: flexLockInv?.investmentId || null,
      planAutoLocked: false,
    };
  }

  const plan = PLAN_CONFIG[resolvedPlan];
  const sellable = (tokenAmount * plan.sellablePercent) / 100;
  const locked = (tokenAmount * plan.lockedPercent) / 100;
  const inv = await insertInvestmentRow(conn, {
    userId,
    planType: resolvedPlan,
    tokenAmount,
    sellable,
    locked,
    incomeEligible,
    lockDays: resolvedPlan === 'lock' ? lockDays : flexLockDays,
  });

  if (!skipTransaction) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
      [userId, 'invest', tokenAmount, `${resolvedPlan} plan investment`, inv.investmentId]
    );
  }

  return {
    ...inv,
    planAutoLocked: resolvedPlan === 'lock' && planType === 'flexible' && tokenAmount < flexibleMin,
  };
}
