import { pool } from '../db.js';
import {
  distributeLevelBonus,
  distributeRewardBonus,
  previewRewardBonus,
} from './incomeService.js';
import { creditUserXit, toPositiveInt } from './tokenPayoutService.js';
import { getBlockchainConfig, isBlockchainMode } from './blockchainService.js';
import { investmentHasIncomeEligible } from './investmentService.js';
import { getISTDateString } from '../utils/istDate.js';

/** Bump when uploading — must appear in cron.log or server is still on old file */
export const PAYOUT_BUILD = '2026-08-26-owner-freeze-v3';

export function calculateInvestmentRoi(inv, asOfDate = null) {
  const today = asOfDate || getISTDateString();
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
      const levelBonus = investmentHasIncomeEligible(inv)
        ? await previewLevelBonus(conn, inv.user_id, calc.roi)
        : 0;
      const reward = investmentHasIncomeEligible(inv)
        ? await previewRewardBonus(conn, inv.user_id, calc.roi)
        : { bonus: 0, tierName: null };

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

    const effectiveDate = asOfDate || getISTDateString();

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

/**
 * @param {object} inv - investment row (amounts, rates, dates)
 * @param {{ userId: number, username: string, walletAddress: string|null }} owner - frozen owner from JOIN (never re-derived)
 */
async function processInvestmentRoi(conn, inv, owner, description = 'Daily ROI payout', asOfDate = null) {
  const calc = calculateInvestmentRoi(inv, asOfDate);
  if (!calc) return null;

  const investmentId = toPositiveInt(inv.id, 'investment.id');
  const ownerUserId = toPositiveInt(owner.userId, 'owner.userId');
  const ownerUsername = String(owner.username || '');
  if (!ownerUsername) {
    throw new Error(`Investment ${investmentId} missing owner username`);
  }

  // Hard abort: historical bug credited seed user id=2 when daysElapsed=2
  if (calc.days != null && Number(calc.days) === ownerUserId && ownerUserId <= 5) {
    throw new Error(
      `Refusing credit: ownerUserId=${ownerUserId} equals ROI days=${calc.days} ` +
        `(likely stale payoutService on server — re-upload PAYOUT_BUILD=${PAYOUT_BUILD})`
    );
  }

  if (calc.roi <= 0) {
    if (calc.completed) {
      await conn.query(`UPDATE investments SET status = ? WHERE id = ${investmentId}`, ['completed']);
    }
    return { investmentId, roi: 0, levelBonus: 0, rewardBonus: 0, completed: calc.completed };
  }

  const totalClaimable = calc.roi;
  const payoutDate = asOfDate || null;
  const createdAt = txCreatedAt(payoutDate);

  console.log(
    `[Payout] credit inv=${investmentId} owner=${ownerUserId}(${ownerUsername}) ` +
      `roi=${totalClaimable} days=${calc.days} wallet=${owner.walletAddress ? 'yes' : 'no'}`
  );

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  const payout = await creditUserXit(conn, ownerUserId, totalClaimable, {
    expectedUsername: ownerUsername,
    walletAddress: owner.walletAddress,
  });

  if (Number(payout.userId) !== ownerUserId) {
    throw new Error(
      `Safety abort: credited userId=${payout.userId} but owner is ${ownerUserId} (${ownerUsername})`
    );
  }
  if (payout.username && payout.username !== ownerUsername) {
    throw new Error(
      `Safety abort: credited username=${payout.username} but owner is ${ownerUsername}`
    );
  }

  const newRoiReceived = Number(inv.roi_received) + totalClaimable;
  const newStatus = newRoiReceived >= Number(inv.total_return) ? 'completed' : 'active';
  const lastRoiDate = payoutDate || getISTDateString();

  await conn.query(
    `UPDATE investments SET roi_received = ?, last_roi_date = ?, status = ? WHERE id = ${investmentId} AND user_id = ${ownerUserId}`,
    [newRoiReceived, lastRoiDate, newStatus]
  );

  const roiDescription = chainMode
    ? `Daily ROI payout (on-chain${payout.txHash ? `: ${payout.txHash}` : ''})`
    : description;

  if (createdAt) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, tx_hash, chain_id, on_chain_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ownerUserId, 'roi', totalClaimable, roiDescription, investmentId, payout.txHash, payout.chainId, payout.onChainStatus, createdAt]
    );
  } else {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, investment_id, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ownerUserId, 'roi', totalClaimable, roiDescription, investmentId, payout.txHash, payout.chainId, payout.onChainStatus]
    );
  }

  const levelBonus = investmentHasIncomeEligible(inv)
    ? await distributeLevelBonus(conn, ownerUserId, totalClaimable, investmentId, payoutDate)
    : 0;
  const rewardBonus = investmentHasIncomeEligible(inv)
    ? await distributeRewardBonus(conn, ownerUserId, totalClaimable, investmentId, payoutDate)
    : 0;

  return {
    investmentId,
    userId: ownerUserId,
    username: ownerUsername,
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
  const failures = [];
  const successes = [];

  const runDate = asOfDate || getISTDateString();
  const isAutoDaily = runType === 'auto' && !asOfDate;

  try {
    const [[dbInfo]] = await conn.query('SELECT DATABASE() AS current_db');
    console.log(
      `[Payout] start build=${PAYOUT_BUILD} runType=${runType} runDate=${runDate} ` +
        `db=${dbInfo?.current_db} envDB=${process.env.DB_NAME || 'MISSING'}`
    );

    if (isAutoDaily) {
      const [existing] = await conn.query(
        `SELECT id, investments_processed, total_payout, created_at
         FROM payout_runs WHERE run_date = ? AND run_type = 'auto' LIMIT 1`,
        [runDate]
      );
      if (existing.length > 0) {
        return {
          skipped: true,
          payoutBuild: PAYOUT_BUILD,
          reason: 'Daily payout already completed for this IST date',
          runId: existing[0].id,
          runDate,
          investmentsProcessed: Number(existing[0].investments_processed),
          totalPayout: Number(existing[0].total_payout),
          alreadyRanAt: existing[0].created_at,
          database: dbInfo?.current_db,
          envDbName: process.env.DB_NAME || null,
        };
      }
    }

    const [investments] = await conn.query(
      `SELECT
         i.id AS investment_id,
         i.user_id AS owner_user_id,
         i.plan_type,
         i.token_amount,
         i.total_return,
         i.daily_roi_rate,
         i.roi_received,
         i.last_roi_date,
         i.status,
         u.username AS owner_username,
         u.wallet_address AS owner_wallet
       FROM investments i
       INNER JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active'
       ORDER BY i.id`
    );

    const description = asOfDate
      ? `Demo ROI payout for ${asOfDate}`
      : runType === 'auto'
        ? 'Auto daily ROI (12 AM IST)'
        : 'Manual ROI payout by admin';

    const config = await getBlockchainConfig(conn);
    const chainMode = isBlockchainMode(config.platformMode);
    const effectiveDescription = chainMode ? 'Daily ROI payout (on-chain)' : description;

    console.log(
      `[Payout] active=${investments.length} mode=${config.platformMode} chainMode=${chainMode}`
    );

    for (const row of investments) {
      // Freeze owner identity as plain primitives from JOIN — never re-derive from another query
      const investmentId = toPositiveInt(row.investment_id, 'investment_id');
      const ownerUserId = toPositiveInt(row.owner_user_id, 'owner_user_id');
      const ownerUsername = String(row.owner_username);
      const ownerWallet =
        row.owner_wallet == null || row.owner_wallet === ''
          ? null
          : String(row.owner_wallet).trim();

      const owner = {
        userId: ownerUserId,
        username: ownerUsername,
        walletAddress: ownerWallet,
      };

      const invSnapshot = {
        id: investmentId,
        user_id: ownerUserId,
        plan_type: row.plan_type,
        token_amount: row.token_amount,
        total_return: row.total_return,
        daily_roi_rate: row.daily_roi_rate,
        roi_received: row.roi_received,
        last_roi_date: row.last_roi_date,
        status: row.status,
      };

      await conn.beginTransaction();
      try {
        const [lockedRows] = await conn.query(
          `SELECT id, user_id, status FROM investments WHERE id = ${investmentId} AND status = 'active' FOR UPDATE`
        );
        const locked = lockedRows[0];
        if (!locked) {
          await conn.rollback();
          failures.push({
            investmentId,
            userId: ownerUserId,
            username: ownerUsername,
            error: 'Investment missing or inactive under lock (skipped)',
          });
          continue;
        }

        const lockedOwnerId = toPositiveInt(locked.user_id, 'locked.user_id');
        if (lockedOwnerId !== ownerUserId) {
          await conn.rollback();
          failures.push({
            investmentId,
            userId: ownerUserId,
            username: ownerUsername,
            error: `user_id mismatch under lock: join=${ownerUserId} locked=${lockedOwnerId}`,
          });
          continue;
        }

        const result = await processInvestmentRoi(
          conn,
          invSnapshot,
          owner,
          effectiveDescription,
          asOfDate
        );
        await conn.commit();

        if (result && result.roi > 0) {
          investmentsProcessed++;
          totalRoi += result.roi;
          totalLevelBonus += result.levelBonus || 0;
          totalRewardBonus += result.rewardBonus || 0;
          successes.push({
            investmentId: result.investmentId,
            userId: result.userId,
            username: result.username,
            roi: result.roi,
            days: result.days,
          });
        }
      } catch (err) {
        await conn.rollback();
        const fail = {
          investmentId,
          userId: ownerUserId,
          username: ownerUsername,
          error: err.message,
        };
        failures.push(fail);
        console.error(
          `Payout failed for investment ${investmentId} userId=${ownerUserId} (${ownerUsername}):`,
          err.message
        );
      }
    }

    const totalPayout = totalRoi + totalLevelBonus + totalRewardBonus;
    const effectiveRunType = asOfDate ? 'manual' : runType;

    let runId = null;
    if (investmentsProcessed > 0 || totalPayout > 0 || !isAutoDaily) {
      const [runResult] = await pool.query(
        `INSERT INTO payout_runs
          (run_type, run_date, investments_processed, total_roi, total_level_bonus, total_reward_bonus, total_payout, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [effectiveRunType, runDate, investmentsProcessed, totalRoi, totalLevelBonus, totalRewardBonus, totalPayout, triggeredBy]
      );
      runId = runResult.insertId;
    } else if (isAutoDaily) {
      const [runResult] = await pool.query(
        `INSERT INTO payout_runs
          (run_type, run_date, investments_processed, total_roi, total_level_bonus, total_reward_bonus, total_payout, triggered_by)
         VALUES (?, ?, 0, 0, 0, 0, 0, ?)`,
        ['auto', runDate, triggeredBy]
      );
      runId = runResult.insertId;
    }

    console.log(
      `[Payout] done processed=${investmentsProcessed} roi=${totalRoi} failures=${failures.length} runId=${runId}`
    );

    return {
      skipped: false,
      payoutBuild: PAYOUT_BUILD,
      runId,
      investmentsProcessed,
      totalRoi,
      totalLevelBonus,
      totalRewardBonus,
      totalPayout,
      payoutDate: runDate,
      database: dbInfo?.current_db,
      envDbName: process.env.DB_NAME || null,
      successCount: successes.length,
      failureCount: failures.length,
      successes: successes.slice(0, 50),
      failures: failures.slice(0, 100),
    };
  } finally {
    conn.release();
  }
}
