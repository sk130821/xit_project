import { pool } from '../db.js';
import {
  distributeLevelBonus,
  distributeRewardBonus,
  previewRewardBonus,
} from './incomeService.js';

export function calculateInvestmentRoi(inv, asOfDate = null) {
  const today = asOfDate || new Date().toISOString().split('T')[0];
  const lastRoi = new Date(inv.last_roi_date).toISOString().split('T')[0];

  if (lastRoi >= today) return null;

  const daysElapsed = Math.floor((new Date(today) - new Date(lastRoi)) / (1000 * 60 * 60 * 24));
  if (daysElapsed <= 0) return null;

  const dailyEarning = (Number(inv.token_amount) * Number(inv.daily_roi_rate)) / 100;
  let totalClaimable = dailyEarning * daysElapsed;

  const remaining = Number(inv.total_return) - Number(inv.roi_received);
  if (totalClaimable > remaining) totalClaimable = remaining;

  if (totalClaimable <= 0) {
    return { investmentId: inv.id, userId: inv.user_id, roi: 0, days: daysElapsed, completed: true };
  }

  return {
    investmentId: inv.id,
    userId: inv.user_id,
    roi: totalClaimable,
    days: daysElapsed,
    completed: Number(inv.roi_received) + totalClaimable >= Number(inv.total_return),
  };
}

async function previewLevelBonus(conn, earnerId, roiAmount) {
  if (roiAmount <= 0) return 0;

  const [uplines] = await conn.query(
    `SELECT rr.upline_id, rr.level, lbr.percentage
     FROM referral_relations rr
     JOIN level_bonus_rates lbr ON lbr.level = rr.level
     WHERE rr.user_id = ?
     ORDER BY rr.level`,
    [earnerId]
  );

  let total = 0;
  for (const upline of uplines) {
    total += (roiAmount * Number(upline.percentage)) / 100;
  }
  return total;
}

function txCreatedAt(payoutDate) {
  return payoutDate ? `${payoutDate} 00:30:00` : null;
}

export async function previewPayout(asOfDate = null) {
  const conn = await pool.getConnection();
  try {
    const [investments] = await conn.query(
      `SELECT i.*, u.username
       FROM investments i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active'`
    );

    let totalRoi = 0;
    let totalLevelBonus = 0;
    let totalRewardBonus = 0;
    let eligibleCount = 0;
    const items = [];

    for (const inv of investments) {
      const calc = calculateInvestmentRoi(inv, asOfDate);
      if (!calc || calc.roi <= 0) continue;

      eligibleCount++;
      const levelBonus = await previewLevelBonus(conn, inv.user_id, calc.roi);
      const reward = await previewRewardBonus(conn, inv.user_id, calc.roi);

      totalRoi += calc.roi;
      totalLevelBonus += levelBonus;
      totalRewardBonus += reward.bonus;

      items.push({
        investmentId: inv.id,
        userId: inv.user_id,
        username: inv.username,
        planType: inv.plan_type,
        tokenAmount: Number(inv.token_amount),
        days: calc.days,
        roiAmount: calc.roi,
        levelBonus,
        rewardBonus: reward.bonus,
        rewardTier: reward.tierName,
      });
    }

    items.sort((a, b) => b.roiAmount - a.roiAmount);

    const effectiveDate = asOfDate || new Date().toISOString().split('T')[0];

    return {
      eligibleInvestments: eligibleCount,
      totalInvestments: investments.length,
      totalRoi,
      totalLevelBonus,
      totalRewardBonus,
      totalPayout: totalRoi + totalLevelBonus + totalRewardBonus,
      items: items.slice(0, 100),
      hasMore: items.length > 100,
      payoutDate: effectiveDate,
    };
  } finally {
    conn.release();
  }
}

async function processInvestmentRoi(conn, inv, description = 'Daily ROI payout', asOfDate = null) {
  const calc = calculateInvestmentRoi(inv, asOfDate);
  if (!calc) return null;

  if (calc.roi <= 0) {
    if (calc.completed) {
      await conn.query('UPDATE investments SET status = ? WHERE id = ?', ['completed', inv.id]);
    }
    return { investmentId: inv.id, roi: 0, levelBonus: 0, rewardBonus: 0, completed: calc.completed };
  }

  const totalClaimable = calc.roi;
  const payoutDate = asOfDate || null;
  const createdAt = txCreatedAt(payoutDate);

  await conn.query(
    'UPDATE users SET xit_balance = xit_balance + ?, total_earned = total_earned + ? WHERE id = ?',
    [totalClaimable, totalClaimable, inv.user_id]
  );

  const newRoiReceived = Number(inv.roi_received) + totalClaimable;
  const newStatus = newRoiReceived >= Number(inv.total_return) ? 'completed' : 'active';
  const lastRoiDate = payoutDate || new Date().toISOString().split('T')[0];

  await conn.query(
    'UPDATE investments SET roi_received = ?, last_roi_date = ?, status = ? WHERE id = ?',
    [newRoiReceived, lastRoiDate, newStatus, inv.id]
  );

  if (createdAt) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, on_chain_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [inv.user_id, 'roi', totalClaimable, description, inv.id, 'demo', createdAt]
    );
  } else {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?)',
      [inv.user_id, 'roi', totalClaimable, description, inv.id, 'demo']
    );
  }

  const levelBonus = await distributeLevelBonus(conn, inv.user_id, totalClaimable, inv.id, payoutDate);
  const rewardBonus = await distributeRewardBonus(conn, inv.user_id, totalClaimable, inv.id, payoutDate);

  return {
    investmentId: inv.id,
    userId: inv.user_id,
    roi: totalClaimable,
    levelBonus,
    rewardBonus,
    days: calc.days,
  };
}

export async function runPayout({ runType = 'manual', triggeredBy = 'admin', asOfDate = null } = {}) {
  const conn = await pool.getConnection();
  let investmentsProcessed = 0;
  let totalRoi = 0;
  let totalLevelBonus = 0;
  let totalRewardBonus = 0;

  try {
    const [investments] = await conn.query(
      "SELECT * FROM investments WHERE status = 'active'"
    );

    const description = asOfDate
      ? `Demo ROI payout for ${asOfDate}`
      : runType === 'auto'
        ? 'Auto daily ROI (12 AM IST)'
        : 'Manual ROI payout by admin';

    for (const inv of investments) {
      await conn.beginTransaction();
      try {
        const [locked] = await conn.query('SELECT * FROM investments WHERE id = ? FOR UPDATE', [inv.id]);
        const result = await processInvestmentRoi(conn, locked[0], description, asOfDate);
        await conn.commit();

        if (result && result.roi > 0) {
          investmentsProcessed++;
          totalRoi += result.roi;
          totalLevelBonus += result.levelBonus || 0;
          totalRewardBonus += result.rewardBonus || 0;
        }
      } catch (err) {
        await conn.rollback();
        console.error(`Payout failed for investment ${inv.id}:`, err.message);
      }
    }

    const totalPayout = totalRoi + totalLevelBonus + totalRewardBonus;
    const runDate = asOfDate || new Date().toISOString().split('T')[0];
    const effectiveRunType = asOfDate ? 'demo' : runType;

    const [runResult] = await pool.query(
      `INSERT INTO payout_runs
        (run_type, run_date, investments_processed, total_roi, total_level_bonus, total_reward_bonus, total_payout, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [effectiveRunType, runDate, investmentsProcessed, totalRoi, totalLevelBonus, totalRewardBonus, totalPayout, triggeredBy]
    );

    return {
      runId: runResult.insertId,
      investmentsProcessed,
      totalRoi,
      totalLevelBonus,
      totalRewardBonus,
      totalPayout,
      payoutDate: runDate,
    };
  } finally {
    conn.release();
  }
}
