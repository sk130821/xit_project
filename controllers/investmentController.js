import { pool } from '../db.js';
import { getSetting, distributeLevelBonus, payRewardBonus } from '../services/incomeService.js';
import { getBlockchainConfig, isBlockchainMode, sendTokenPayout } from '../services/blockchainService.js';
import { createInvestmentForUser } from '../services/investmentService.js';

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

    const today = new Date().toISOString().split('T')[0];
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

    await conn.query(
      'UPDATE users SET xit_balance = xit_balance + ?, total_earned = total_earned + ? WHERE id = ?',
      [totalClaimable, totalClaimable, req.userId]
    );

    const newRoiReceived = Number(inv.roi_received) + totalClaimable;
    const newStatus = newRoiReceived >= Number(inv.total_return) ? 'completed' : 'active';

    await conn.query(
      'UPDATE investments SET roi_received = ?, last_roi_date = CURRENT_DATE(), status = ? WHERE id = ?',
      [newRoiReceived, newStatus, investmentId]
    );

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
      [req.userId, 'roi', totalClaimable, 'Daily ROI income', investmentId]
    );

    const levelBonusTotal = await distributeLevelBonus(conn, req.userId, totalClaimable, investmentId);
    const rewardBonus = await payRewardBonus(conn, req.userId, totalClaimable, investmentId);

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
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function sellTokens(req, res) {
  const conn = await pool.getConnection();
  try {
    const { tokenAmount } = req.body;

    if (!tokenAmount || tokenAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    await conn.beginTransaction();

    const [users] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [req.userId]);
    if (users.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    if (!user.is_active) {
      await conn.rollback();
      return res.status(403).json({ error: 'Account not activated' });
    }

    const xitBalance = Number(user.xit_balance || 0);
    const [invRows] = await conn.query(
      'SELECT COALESCE(SUM(sellable_amount), 0) as total FROM investments WHERE user_id = ? AND status = ? AND sellable_amount > 0',
      [req.userId, 'active']
    );
    const sellableFromInvestments = Number(invRows[0].total);
    const totalSellable = xitBalance + sellableFromInvestments;

    if (tokenAmount > totalSellable) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient sellable XIT tokens' });
    }

    const amountFromXitBalance = Math.min(tokenAmount, xitBalance);
    const amountFromInvestments = tokenAmount - amountFromXitBalance;

    const adminRateStr = await getSetting(conn, 'admin_charge_percent', '10');
    const adminRate = parseFloat(adminRateStr);
    const adminCharge = (tokenAmount * adminRate) / 100;
    const netXit = tokenAmount - adminCharge;
    const tokenPrice = parseFloat(await getSetting(conn, 'token_price', '1'));
    const usdtPayout = netXit * tokenPrice;

    const config = await getBlockchainConfig(conn);
    const chainMode = isBlockchainMode(config.platformMode);

    if (chainMode && !user.wallet_address) {
      await conn.rollback();
      return res.status(400).json({ error: 'Link your MetaMask wallet before selling in blockchain mode' });
    }

    if (amountFromXitBalance > 0) {
      await conn.query('UPDATE users SET xit_balance = xit_balance - ? WHERE id = ?', [amountFromXitBalance, req.userId]);
    }

    if (amountFromInvestments > 0) {
      let remainder = amountFromInvestments;

      while (remainder > 0) {
        const [invs] = await conn.query(
          'SELECT id, sellable_amount FROM investments WHERE user_id = ? AND status = ? AND sellable_amount > 0 ORDER BY created_at LIMIT 1 FOR UPDATE',
          [req.userId, 'active']
        );

        if (invs.length === 0) break;

        const inv = invs[0];
        const available = Number(inv.sellable_amount);

        if (available >= remainder) {
          await conn.query('UPDATE investments SET sellable_amount = sellable_amount - ? WHERE id = ?', [remainder, inv.id]);
          remainder = 0;
        } else {
          await conn.query('UPDATE investments SET sellable_amount = 0 WHERE id = ?', [inv.id]);
          remainder -= available;
        }
      }

      await conn.query(
        'UPDATE users SET total_invested = GREATEST(0, total_invested - ?) WHERE id = ?',
        [amountFromInvestments, req.userId]
      );
    }

    let payoutTxHash = null;
    let payoutChainId = null;
    let onChainStatus = 'demo';

    if (chainMode) {
      try {
        const payout = await sendTokenPayout(conn, user.wallet_address, netXit);
        payoutTxHash = payout.txHash;
        payoutChainId = payout.chainId;
        onChainStatus = 'confirmed';
      } catch (payoutErr) {
        await conn.rollback();
        return res.status(400).json({ error: `On-chain payout failed: ${payoutErr.message}` });
      }
    } else {
      await conn.query(
        'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?',
        [usdtPayout, req.userId]
      );
    }

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        req.userId,
        'sell',
        usdtPayout,
        chainMode
          ? `Sold ${tokenAmount} XIT (net ${netXit} XIT, admin charge ${adminCharge} XIT)`
          : `Sold ${tokenAmount} XIT → ${usdtPayout.toFixed(2)} USDT (admin charge: ${adminCharge} XIT)`,
        payoutTxHash,
        payoutChainId,
        onChainStatus,
      ]
    );

    await conn.commit();

    res.json({
      success: true,
      sold: tokenAmount,
      adminCharge,
      net: netXit,
      usdtReceived: chainMode ? null : usdtPayout,
      txHash: payoutTxHash,
      mode: chainMode ? config.platformMode : 'demo',
      explorerUrl: payoutTxHash ? `${config.blockExplorerUrl}/tx/${payoutTxHash}` : null,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Sell error:', err);
    res.status(500).json({ error: 'Server error during sale' });
  } finally {
    conn.release();
  }
}
