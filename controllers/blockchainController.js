import { pool } from '../db.js';
import { getBlockchainConfig, isBlockchainMode, verifyBuyTransaction, sendTokenPayout, getTreasuryTokenBalance } from '../services/blockchainService.js';
import { getSetting, distributeReferralBonus } from '../services/incomeService.js';
import { createInvestmentForUser } from '../services/investmentService.js';

export async function getConfig(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const config = await getBlockchainConfig(conn);
      const onChainBalance = await getTreasuryTokenBalance(conn);

      res.json({
        ...config,
        onChainBalance,
        requiresWallet: isBlockchainMode(config.platformMode),
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function linkWallet(req, res) {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    await pool.query('UPDATE users SET wallet_address = ? WHERE id = ?', [walletAddress, req.userId]);

    res.json({ success: true, wallet_address: walletAddress });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function verifyAndBuy(req, res) {
  const conn = await pool.getConnection();
  try {
    const { txHash, tokenAmount, planType } = req.body;

    if (!txHash || !tokenAmount || tokenAmount <= 0) {
      return res.status(400).json({ error: 'Transaction hash and token amount required' });
    }

    if (!planType || !['lock', 'flexible'].includes(planType)) {
      return res.status(400).json({ error: 'Select a plan: lock or flexible' });
    }

    const config = await getBlockchainConfig(conn);
    if (!isBlockchainMode(config.platformMode)) {
      return res.status(400).json({ error: 'On-chain purchase only available in testnet/real mode' });
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

    if (!user.wallet_address) {
      await conn.rollback();
      return res.status(400).json({ error: 'Link your wallet before on-chain purchase' });
    }

    const paymentAmount = tokenAmount * config.tokenPrice;
    const { chainId } = await verifyBuyTransaction(conn, txHash, paymentAmount, user.wallet_address);

    await conn.query(
      'UPDATE users SET total_purchased = total_purchased + ?, is_active = 1 WHERE id = ?',
      [tokenAmount, req.userId]
    );

    const investment = await createInvestmentForUser(conn, req.userId, tokenAmount, planType, {
      skipWalletDeduction: true,
      skipTransaction: true,
    });

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, investment_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        req.userId,
        'buy',
        tokenAmount,
        `Buy & Invest — ${planType} plan (${config.paymentTokenSymbol})`,
        txHash,
        chainId,
        investment.investmentId,
        'confirmed',
      ]
    );

    const referralBonus = await distributeReferralBonus(conn, req.userId, tokenAmount);

    await conn.commit();

    res.json({
      success: true,
      tokens: tokenAmount,
      referralBonus,
      txHash,
      investment,
      accountActivated: wasInactive,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Verify buy error:', err);
    res.status(400).json({ error: err.message || 'Failed to verify transaction' });
  } finally {
    conn.release();
  }
}

export async function getAdminBlockchainStatus(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const config = await getBlockchainConfig(conn);
      const onChainBalance = await getTreasuryTokenBalance(conn);
      const hasPrivateKey = !!process.env.ADMIN_PRIVATE_KEY;

      res.json({
        ...config,
        onChainBalance,
        hasPrivateKey,
        payoutWallet: config.adminPayoutWallet || config.adminTreasuryWallet,
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export { sendTokenPayout };
