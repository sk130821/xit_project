import { pool } from '../db.js';
import {
  getBlockchainConfig,
  isBlockchainMode,
  verifyBuyTransaction,
  sendTokenPayout,
  getTreasuryTokenBalance,
  getAdminWalletBalances,
} from '../services/blockchainService.js';
import { getSetting, distributeReferralBonus } from '../services/incomeService.js';
import { createInvestmentForUser } from '../services/investmentService.js';
import { getUserOnChainXitBalance, computeBlockchainSellable } from '../services/tokenPayoutService.js';

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

export async function getMemberWalletBalance(req, res) {
  const conn = await pool.getConnection();
  try {
    const [users] = await conn.query('SELECT wallet_address FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const config = await getBlockchainConfig(conn);
    const chainMode = isBlockchainMode(config.platformMode);

    if (!chainMode) {
      return res.json({ chainMode: false, onChainXitBalance: null });
    }

    const walletAddress = users[0].wallet_address;
    if (!walletAddress) {
      return res.json({
        chainMode: true,
        onChainXitBalance: 0,
        planSellable: 0,
        planLocked: 0,
        totalSellable: 0,
        incomeBalance: 0,
      });
    }

    const [invStats] = await conn.query(
      `SELECT
        COALESCE(SUM(sellable_amount), 0) AS plan_sellable,
        COALESCE(SUM(locked_amount), 0) AS plan_locked
       FROM investments WHERE user_id = ? AND status = 'active'`,
      [req.userId]
    );

    const planSellable = Number(invStats[0].plan_sellable);
    const planLocked = Number(invStats[0].plan_locked);
    const onChainXitBalance = await getUserOnChainXitBalance(conn, walletAddress);
    const incomeBalance = Math.max(0, onChainXitBalance - planSellable - planLocked);
    const totalSellable = computeBlockchainSellable(onChainXitBalance, planSellable, planLocked);

    res.json({
      chainMode: true,
      walletAddress,
      onChainXitBalance,
      planSellable,
      planLocked,
      incomeBalance,
      totalSellable,
    });
  } catch (err) {
    console.error('Wallet balance error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
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

    const minPurchase = parseFloat(await getSetting(conn, 'min_purchase', '1'));

    if (tokenAmount < minPurchase) {
      return res.status(400).json({ error: `Minimum purchase is ${minPurchase} tokens` });
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

    let tokenPayoutTxHash = null;
    try {
      const tokenPayout = await sendTokenPayout(conn, user.wallet_address, tokenAmount);
      tokenPayoutTxHash = tokenPayout.txHash;
    } catch (payoutErr) {
      await conn.rollback();
      return res.status(400).json({ error: `XIT delivery failed: ${payoutErr.message}` });
    }

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
        `Buy & Invest — ${planType} plan (${config.paymentTokenSymbol}). XIT payout: ${tokenPayoutTxHash}`,
        txHash,
        chainId,
        investment.investmentId,
        'confirmed',
      ]
    );

    const referralBonus = investment.incomeEligible
      ? await distributeReferralBonus(conn, req.userId, tokenAmount)
      : 0;

    await conn.commit();

    res.json({
      success: true,
      tokens: tokenAmount,
      referralBonus,
      txHash,
      tokenPayoutTxHash,
      investment,
      accountActivated: wasInactive,
      explorerUrl: config.blockExplorerUrl ? `${config.blockExplorerUrl}/tx/${tokenPayoutTxHash}` : null,
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
      const adminBalances = await getAdminWalletBalances(conn);
      const hasPrivateKey = !!process.env.ADMIN_PRIVATE_KEY;

      res.json({
        ...config,
        onChainBalance,
        adminBalances,
        hasPrivateKey,
        payoutWallet: config.adminPayoutWallet || config.adminTreasuryWallet,
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Admin blockchain status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export { sendTokenPayout };
