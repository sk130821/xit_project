import { pool } from '../db.js';
import { distributeLevelBonus, distributeRewardBonus } from '../services/incomeService.js';
import {
  getBlockchainConfig,
  isBlockchainMode,
  verifySellTokenTransfer,
} from '../services/blockchainService.js';
import { createInvestmentForUser, formatRoiDescription, investmentHasIncomeEligible } from '../services/investmentService.js';
import { creditUserXit } from '../services/tokenPayoutService.js';
import { applyLockPlanCompletionSellable, unlockMaturedLockRoiSellable } from '../services/sellBalanceService.js';
import { calculateInvestmentRoiAccrual } from '../services/roiAccrualService.js';
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
import { recordFailedSellStandalone } from '../services/tradeFailureService.js';

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

    const calc = calculateInvestmentRoiAccrual(inv);
    if (!calc) {
      await conn.rollback();
      return res.status(400).json({ error: 'ROI already claimed today' });
    }

    const totalClaimable = calc.roi;

    if (totalClaimable <= 0) {
      if (calc.completed) {
        await conn.query('UPDATE investments SET status = ?, last_roi_date = ? WHERE id = ?', [
          'completed',
          calc.lastRoiDate,
          investmentId,
        ]);
      }
      await conn.commit();
      return res.json({ success: true, completed: true, roi: 0 });
    }

    const payout = await creditUserXit(conn, req.userId, totalClaimable);

    const newRoiReceived = Number(inv.roi_received) + totalClaimable;
    const newStatus = calc.completed ? 'completed' : 'active';

    await conn.query(
      'UPDATE investments SET roi_received = ?, last_roi_date = ?, status = ? WHERE id = ?',
      [newRoiReceived, calc.lastRoiDate, newStatus, investmentId]
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
  const conn = await pool.getConnection();
  try {
    await unlockMaturedLockRoiSellable(conn, req.userId);
    const [investments] = await conn.query(
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
  } finally {
    conn.release();
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
    let verifiedChain = null;

    if (chainMode && txHash) {
      const [lockedUsers] = await conn.query('SELECT wallet_address FROM users WHERE id = ? FOR UPDATE', [
        req.userId,
      ]);
      if (!lockedUsers.length || !lockedUsers[0].wallet_address) {
        await conn.rollback();
        return res.status(400).json({ error: 'Link your MetaMask wallet before selling in blockchain mode' });
      }
      try {
        verifiedChain = await verifySellTokenTransfer(
          conn,
          txHash,
          tokenAmount,
          lockedUsers[0].wallet_address
        );
      } catch (verifyErr) {
        await conn.rollback();
        await recordFailedSellStandalone({
          userId: req.userId,
          tokenAmount,
          txHash,
          chainId: null,
          usdtAmount: 0,
          reason: verifyErr.message || 'On-chain XIT transfer not verified',
          xitVerifiedOnChain: false,
        });
        return res.status(400).json({ error: verifyErr.message || 'On-chain XIT transfer not verified' });
      }
    }

    try {
      quote = await evaluateSellEligibility(conn, req.userId, tokenAmount, investmentId, {
        lock: true,
        postTransferVerified: Boolean(chainMode && txHash && verifiedChain),
      });
    } catch (eligErr) {
      await conn.rollback();
      if (chainMode && txHash && verifiedChain) {
        await recordFailedSellStandalone({
          userId: req.userId,
          tokenAmount,
          txHash,
          chainId: verifiedChain.chainId,
          usdtAmount: 0,
          reason: eligErr.message || 'Sell not allowed',
          xitVerifiedOnChain: true,
        });
      }
      return res.status(400).json({ error: eligErr.message || 'Sell not allowed' });
    }

    if (!quote.chainMode) {
      await applySellLedger(conn, {
        userId: req.userId,
        amountFromXitBalance: quote.amountFromXitBalance,
        amountFromOtherIncome: quote.amountFromOtherIncome,
        amountFromFlexRoi: quote.amountFromFlexRoi,
        amountFromInvestments: quote.amountFromInvestments,
        targetInvestmentId: quote.targetInvestmentId,
        flexRoiInvestmentId: quote.flexRoiInvestmentId ?? null,
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
      const verified = verifiedChain || (await verifySellTokenTransfer(
        conn,
        txHash,
        tokenAmount,
        quote.user.wallet_address
      ));
      await persistXitReceivedSell(conn, {
        userId: req.userId,
        tokenAmount,
        adminCharge: quote.adminCharge,
        netXit: quote.netXit,
        usdtPayout: quote.usdtPayout,
        paymentSymbol: quote.paymentSymbol,
        amountFromXitBalance: quote.amountFromXitBalance,
        amountFromOtherIncome: quote.amountFromOtherIncome,
        amountFromFlexRoi: quote.amountFromFlexRoi,
        amountFromInvestments: quote.amountFromInvestments,
        targetInvestmentId: quote.targetInvestmentId,
        flexRoiInvestmentId: quote.flexRoiInvestmentId ?? null,
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
      await recordFailedSellStandalone({
        userId: req.userId,
        tokenAmount,
        txHash,
        chainId: verifiedChain?.chainId ?? null,
        usdtAmount: quote?.usdtPayout ?? 0,
        reason: chainErr.message || 'On-chain sell failed',
        xitVerifiedOnChain: Boolean(verifiedChain),
      });
      return res.status(400).json({ error: chainErr.message || 'On-chain sell failed' });
    }

    const order = await findSellOrderByXitHash(conn, txHash);
    const payout = await attemptSellPayout(order);
    const latest = await findSellOrderByXitHash(conn, txHash);
    return res.json(buildSellResponse(latest || order, payout, config));
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error('Sell error:', err);
    const bodyHash = req.body?.txHash ? String(req.body.txHash).trim() : '';
    if (bodyHash && req.body?.tokenAmount > 0) {
      await recordFailedSellStandalone({
        userId: req.userId,
        tokenAmount: Number(req.body.tokenAmount),
        txHash: bodyHash,
        chainId: null,
        usdtAmount: 0,
        reason: err.message || 'Server error during sale',
        xitVerifiedOnChain: false,
      });
    }
    res.status(500).json({ error: 'Server error during sale' });
  } finally {
    conn.release();
  }
}
