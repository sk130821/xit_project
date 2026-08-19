import { pool } from '../db.js';
import { getSetting, distributeReferralBonus } from '../services/incomeService.js';
import { getBlockchainConfig, isBlockchainMode } from '../services/blockchainService.js';
import { createInvestmentForUser } from '../services/investmentService.js';

export async function buyTokens(req, res) {
  const conn = await pool.getConnection();
  try {
    const { tokenAmount, planType } = req.body;

    if (!tokenAmount || tokenAmount <= 0) {
      return res.status(400).json({ error: 'Invalid token amount' });
    }

    if (!planType || !['lock', 'flexible'].includes(planType)) {
      return res.status(400).json({ error: 'Select a plan: lock or flexible' });
    }

    const config = await getBlockchainConfig(conn);
    if (isBlockchainMode(config.platformMode)) {
      conn.release();
      return res.status(400).json({
        error: 'On-chain mode active. Connect MetaMask and use blockchain purchase.',
        requiresOnChain: true,
      });
    }

    const minPurchase = parseFloat(await getSetting(conn, 'min_purchase', '10'));
    const minInvestment = parseFloat(await getSetting(conn, 'min_investment', '100'));
    const minAmount = Math.max(minPurchase, minInvestment);

    if (tokenAmount < minAmount) {
      return res.status(400).json({ error: `Minimum purchase is ${minAmount} tokens` });
    }

    await conn.beginTransaction();

    const [users] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [req.userId]);
    if (users.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    const wasInactive = !user.is_active;

    const tokenPrice = parseFloat(await getSetting(conn, 'token_price', '1'));
    const usdtCost = tokenAmount * tokenPrice;

    if (Number(user.wallet_balance) < usdtCost) {
      await conn.rollback();
      return res.status(400).json({
        error: `Insufficient USDT balance. Need ${usdtCost.toFixed(2)} USDT, have ${Number(user.wallet_balance).toFixed(2)} USDT`,
      });
    }

    await conn.query(
      'UPDATE users SET wallet_balance = wallet_balance - ?, total_purchased = total_purchased + ?, is_active = 1 WHERE id = ?',
      [usdtCost, tokenAmount, req.userId]
    );

    const investment = await createInvestmentForUser(conn, req.userId, tokenAmount, planType, {
      skipWalletDeduction: true,
      skipTransaction: true,
    });

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?)',
      [
        req.userId,
        'buy',
        tokenAmount,
        `Buy & Invest — ${planType} plan (${usdtCost.toFixed(2)} USDT, demo mode)`,
        investment.investmentId,
        'demo',
      ]
    );

    const referralBonus = await distributeReferralBonus(conn, req.userId, tokenAmount);

    await conn.commit();

    res.json({
      success: true,
      tokens: tokenAmount,
      referralBonus,
      mode: 'demo',
      investment,
      accountActivated: wasInactive,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Buy error:', err);
    res.status(err.message?.includes('Minimum') || err.message?.includes('Invalid') ? 400 : 500).json({
      error: err.message || 'Server error during purchase',
    });
  } finally {
    conn.release();
  }
}
