import { pool } from '../db.js';
import { distributeLevelBonus, distributeRewardBonus } from '../services/incomeService.js';
import {
  getBlockchainConfig,
  isBlockchainMode,
  verifySellTokenTransfer,
} from '../services/blockchainService.js';
import { createInvestmentForUser, formatRoiDescription, investmentHasIncomeEligible } from '../services/investmentService.js';
import { creditUserXit } from '../services/tokenPayoutService.js';
import { applyLockPlanCompletionSellable } from '../services/sellBalanceService.js';
import { evaluateSellEligibility, runSellPreflight } from '../services/sellValidationService.js';
import {
  applySellLedger,
  attemptSellPayout,
  buildSellResponse,
  ensureSellOrdersTable,
  findSellOrderByXitHash,
  persistXitReceivedSell,
} from '../services/sellOrderService.js';
import { getISTDateString } from '../utils/istDate.js';

const PLAN_CONFIG = {
  lock: { profitMultiplier: 3, dailyRoi: 0.82, sellablePercent: 0, lockedPercent: 100 },
  flexible: { profitMultiplier: 2, dailyRoi: 0.53, sellablePercent: 80, lockedPercent: 20 },
};

function calcTotalReturn(tokenAmount, plan) {
  return tokenAmount * (1 + plan.profitMultiplier);
}

export async function createInvestment(req, res) {
  const conn = await pool.getConnection();
  try {
    const { tokenAmount, planType } = req.body;

    await conn.beginTransaction();
    const investment = await createInvestmentForUser(conn, req.userId, tokenAmount, planType);
    await conn.commit();

    res.json({ success: true, ...investment });
  } catch (err) {
    await conn.rollback();
    console.error('Investment error:', err);
    res.status(err.message?.includes('Minimum') || err.message?.includes('Insufficient') ? 400 : 500).json({
      error: err.message || 'Server error during investment',
    });
  } finally {
    conn.release();
  }
}

export async function claimRoi(req, res) {
  const conn = await pool.getConnection();
  try {
    const { investmentId } = req.body;

    await conn.beginTransaction();

    const [investments] = await conn.query('SELECT * FROM investments WHERE id = ? AND user_id = ? FOR UPDATE', [investmentId, req.userId]);
    if (investments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Investment not found' });
    }

    const inv = investments[0];
    if (inv.status !== 'active') {
      await conn.rollback();
      return res.status(400).json({ error: 'Investment is not active' });
    }

    const today = getISTDateString();
    const lastRoi = new Date(inv.last_roi_date).toISOString().split('T')[0];

    if (lastRoi >= today) {
      await conn.rollback();
      return res.status(400).json({ error: 'ROI already claimed today' });
    }

    const daysElapsed = Math.floor((new Date(today) - new Date(lastRoi)) / (1000 * 60 * 60 * 24));
    const dailyEarning = (Number(inv.token_amount) * Number(inv.daily_roi_rate)) / 100;
    let totalClaimable = dailyEarning * daysElapsed;

    const remaining = Number(inv.total_return) - Number(inv.roi_received);
    if (totalClaimable > remaining) {
      totalClaimable = remaining;
    }

    if (totalClaimable <= 0) {
      await conn.query('UPDATE investments SET status = ? WHERE id = ?', ['completed', investmentId]);
      await conn.commit();
      return res.json({ success: true, completed: true, roi: 0 });
    }

    const payout = await creditUserXit(conn, req.userId, totalClaimable);

    const newRoiReceived = Number(inv.roi_received) + totalClaimable;
    const newStatus = newRoiReceived >= Number(inv.total_return) ? 'completed' : 'active';

    await conn.query(
      'UPDATE investments SET roi_received = ?, last_roi_date = CURRENT_DATE(), status = ? WHERE id = ?',
      [newRoiReceived, newStatus, investmentId]
    );

    await applyLockPlanCompletionSellable(conn, investmentId, inv.plan_type, newStatus, newRoiReceived);

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.userId, 'roi', totalClaimable, formatRoiDescription(inv.plan_type), investmentId, payout.txHash, payout.chainId, payout.onChainStatus]
    );

    const levelBonusTotal = investmentHasIncomeEligible(inv)
      ? await distributeLevelBonus(conn, req.userId, totalClaimable, investmentId)
      : 0;
    const rewardBonus = investmentHasIncomeEligible(inv)
      ? await distributeRewardBonus(conn, req.userId, totalClaimable, investmentId)
      : 0;

    await conn.commit();

    res.json({
      success: true,
      roi: totalClaimable,
      levelBonusDistributed: levelBonusTotal,
      rewardBonus,
      days: daysElapsed,
      totalReceived: newRoiReceived,
      totalReturn: Number(inv.total_return),
    });
  } catch (err) {
    await conn.rollback();
    console.error('ROI claim error:', err);
    res.status(500).json({ error: 'Server error during ROI claim' });
  } finally {
    conn.release();
  }
}

export async function listInvestments(req, res) {
  try {
    const [investments] = await pool.query(
      'SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );

    res.json(investments.map((inv) => ({
      ...inv,
      token_amount: Number(inv.token_amount),
      total_return: Number(inv.total_return),
      daily_roi_rate: Number(inv.daily_roi_rate),
      roi_received: Number(inv.roi_received),
      sellable_amount: Number(inv.sellable_amount),
      locked_amount: Number(inv.locked_amount),
      income_eligible: investmentHasIncomeEligible(inv),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function sellPreflight(req, res) {
  const conn = await pool.getConnection();
  try {
    const { tokenAmount, investmentId } = req.body;

    const result = await runSellPreflight(conn, req.userId, tokenAmount, investmentId);

    res.json({
      ok: true,
      mode: result.mode,
      usdtPayout: result.usdtPayout,
      paymentSymbol: result.paymentSymbol,
      adminCharge: result.adminCharge,
      netXit: result.netXit,
      adminWallet: result.adminWallet || null,
      minUserBnb: result.minUserBnb || null,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Sell pre-check failed' });
  } finally {
    conn.release();
  }
}

export async function sellTokens(req, res) {
  const conn = await pool.getConnection();
  try {
    const { tokenAmount, txHash, investmentId } = req.body;

    if (!tokenAmount || tokenAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    await ensureSellOrdersTable(conn);
    const config = await getBlockchainConfig(conn);
    const chainMode = isBlockchainMode(config.platformMode);

    if (chainMode && txHash) {
      const existing = await findSellOrderByXitHash(conn, txHash);
      if (existing) {
        if (existing.user_id !== req.userId) {
          return res.status(400).json({ error: 'Transaction hash already used' });
        }
        if (existing.status === 'completed') {
          return res.status(400).json({ error: 'This sell was already completed' });
        }
        const retry = await attemptSellPayout(existing);
        const order = await findSellOrderByXitHash(conn, txHash);
        return res.json(buildSellResponse(order || existing, retry, config));
      }
    }

    await conn.beginTransaction();

    let quote;
    try {
      quote = await evaluateSellEligibility(conn, req.userId, tokenAmount, investmentId, { lock: true });
    } catch (eligErr) {
      await conn.rollback();
      return res.status(400).json({ error: eligErr.message || 'Sell not allowed' });
    }

    if (!quote.chainMode) {
      await applySellLedger(conn, {
        userId: req.userId,
        amountFromXitBalance: quote.amountFromXitBalance,
        amountFromInvestments: quote.amountFromInvestments,
        targetInvestmentId: quote.targetInvestmentId,
        chainMode: false,
      });
      await conn.query(
        'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?',
        [quote.usdtPayout, req.userId]
      );
      await conn.query(
        'INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          req.userId,
          'sell',
          quote.usdtPayout,
          `Sold ${tokenAmount} XIT → ${quote.usdtPayout.toFixed(2)} USDT (admin charge: ${quote.adminCharge} XIT)`,
          null,
          null,
          'demo',
        ]
      );
      await conn.commit();
      return res.json({
        success: true,
        sold: tokenAmount,
        investmentId: quote.targetInvestmentId,
        adminCharge: quote.adminCharge,
        net: quote.netXit,
        usdtReceived: quote.usdtPayout,
        paymentSymbol: 'USDT',
        txHash: null,
        tokenReturnTxHash: null,
        mode: 'demo',
        explorerUrl: null,
        tokenReturnExplorerUrl: null,
      });
    }

    if (!txHash) {
      await conn.rollback();
      return res.status(400).json({ error: 'Send XIT to admin wallet first, then submit transaction hash' });
    }

    try {
      const verified = await verifySellTokenTransfer(conn, txHash, tokenAmount, quote.user.wallet_address);
      await persistXitReceivedSell(conn, {
        userId: req.userId,
        tokenAmount,
        adminCharge: quote.adminCharge,
        netXit: quote.netXit,
        usdtPayout: quote.usdtPayout,
        paymentSymbol: quote.paymentSymbol,
        amountFromXitBalance: quote.amountFromXitBalance,
        amountFromInvestments: quote.amountFromInvestments,
        targetInvestmentId: quote.targetInvestmentId,
        xitTxHash: txHash,
        chainId: verified.chainId,
      });
      await conn.commit();
    } catch (chainErr) {
      await conn.rollback();
      if (chainErr.code === 'ER_DUP_ENTRY') {
        const existing = await findSellOrderByXitHash(conn, txHash);
        if (existing && existing.user_id === req.userId && existing.status !== 'completed') {
          const retry = await attemptSellPayout(existing);
          const order = await findSellOrderByXitHash(conn, txHash);
          return res.json(buildSellResponse(order || existing, retry, config));
        }
        return res.status(400).json({ error: 'Transaction hash already used' });
      }
      return res.status(400).json({ error: chainErr.message || 'On-chain sell failed' });
    }

    const order = await findSellOrderByXitHash(conn, txHash);
    const payout = await attemptSellPayout(order);
    const latest = await findSellOrderByXitHash(conn, txHash);
    return res.json(buildSellResponse(latest || order, payout, config));
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error('Sell error:', err);
    res.status(500).json({ error: 'Server error during sale' });
  } finally {
    conn.release();
  }
}
