import { getSetting } from './incomeService.js';

export const PLAN_CONFIG = {
  lock: { profitMultiplier: 3, dailyRoi: 0.82, sellablePercent: 0, lockedPercent: 100 },
  flexible: { profitMultiplier: 2, dailyRoi: 0.53, sellablePercent: 80, lockedPercent: 20 },
};

export function calcTotalReturn(tokenAmount, plan) {
  return tokenAmount * (1 + plan.profitMultiplier);
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

  const plan = PLAN_CONFIG[resolvedPlan];
  const lockDays = parseInt(
    resolvedPlan === 'lock'
      ? await getSetting(conn, 'lock_period_days', '365')
      : await getSetting(conn, 'flexible_lock_days', '365')
  );

  const totalReturn = calcTotalReturn(tokenAmount, plan);
  const sellable = (tokenAmount * plan.sellablePercent) / 100;
  const locked = (tokenAmount * plan.lockedPercent) / 100;
  const endDate = new Date(Date.now() + lockDays * 24 * 60 * 60 * 1000);

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

  const [invResult] = await conn.query(
    `INSERT INTO investments (user_id, plan_type, token_amount, total_return, daily_roi_rate, sellable_amount, locked_amount, end_date, income_eligible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, resolvedPlan, tokenAmount, totalReturn, plan.dailyRoi, sellable, locked, endDate, incomeEligible]
  );

  if (!skipTransaction) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
      [userId, 'invest', tokenAmount, `${resolvedPlan} plan investment`, invResult.insertId]
    );
  }

  return {
    investmentId: invResult.insertId,
    plan: resolvedPlan,
    amount: tokenAmount,
    totalReturn,
    profitMultiplier: plan.profitMultiplier,
    dailyRoi: plan.dailyRoi,
    sellable,
    locked,
    incomeEligible: incomeEligible === 1,
    planAutoLocked: resolvedPlan === 'lock' && planType === 'flexible' && tokenAmount < flexibleMin,
  };
}
