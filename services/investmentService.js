import { getSetting } from './incomeService.js';

export const PLAN_CONFIG = {
  lock: { profitMultiplier: 3, dailyRoi: 0.82, sellablePercent: 0, lockedPercent: 100 },
  flexible: { profitMultiplier: 2, dailyRoi: 0.53, sellablePercent: 80, lockedPercent: 20 },
};

export function calcTotalReturn(tokenAmount, plan) {
  return tokenAmount * (1 + plan.profitMultiplier);
}

export async function createInvestmentForUser(conn, userId, tokenAmount, planType, options = {}) {
  const { skipWalletDeduction = false, skipTransaction = false } = options;
  const minInvestment = parseFloat(await getSetting(conn, 'min_investment', '100'));
  if (!tokenAmount || tokenAmount < minInvestment) {
    throw new Error(`Minimum investment is ${minInvestment} tokens`);
  }
  if (!PLAN_CONFIG[planType]) {
    throw new Error('Invalid plan type');
  }

  const [users] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (users.length === 0) throw new Error('User not found');

  const user = users[0];
  if (!skipWalletDeduction && tokenAmount > Number(user.xit_balance || 0)) {
    throw new Error('Insufficient XIT balance');
  }

  const plan = PLAN_CONFIG[planType];
  const lockDays = parseInt(
    planType === 'lock'
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
    `INSERT INTO investments (user_id, plan_type, token_amount, total_return, daily_roi_rate, sellable_amount, locked_amount, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, planType, tokenAmount, totalReturn, plan.dailyRoi, sellable, locked, endDate]
  );

  if (!skipTransaction) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
      [userId, 'invest', tokenAmount, `${planType} plan investment`, invResult.insertId]
    );
  }

  return {
    investmentId: invResult.insertId,
    plan: planType,
    amount: tokenAmount,
    totalReturn,
    profitMultiplier: plan.profitMultiplier,
    dailyRoi: plan.dailyRoi,
    sellable,
    locked,
  };
}
