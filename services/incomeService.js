import { creditUserXit } from './tokenPayoutService.js';

export async function getSetting(conn, key, fallback) {
  const [rows] = await conn.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  if (rows.length === 0) return fallback;
  return rows[0].setting_value;
}

async function insertIncomeTransaction(conn, {
  userId, type, amount, description, relatedUserId = null, investmentId = null, payout = null, createdAt = null,
}) {
  const txHash = payout?.txHash || null;
  const chainId = payout?.chainId || null;
  const onChainStatus = payout?.onChainStatus || 'demo';

  if (createdAt) {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, related_user_id, investment_id, tx_hash, chain_id, on_chain_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, type, amount, description, relatedUserId, investmentId, txHash, chainId, onChainStatus, createdAt]
    );
  } else {
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, related_user_id, investment_id, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, type, amount, description, relatedUserId, investmentId, txHash, chainId, onChainStatus]
    );
  }
}

export async function distributeReferralBonus(conn, buyerId, tokenAmount) {
  const minPurchase = parseFloat(await getSetting(conn, 'min_referral_purchase', '100'));
  const bonusPercent = parseFloat(await getSetting(conn, 'referral_bonus_percent', '5'));

  if (tokenAmount < minPurchase) {
    return 0;
  }

  const [buyers] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [buyerId]);
  const sponsorId = buyers[0]?.sponsor_id;
  if (!sponsorId) return 0;

  const bonus = (tokenAmount * bonusPercent) / 100;

  const payout = await creditUserXit(conn, sponsorId, bonus, { skipIfNoWallet: true });
  if (!payout.credited) {
    console.warn(
      `[ReferralBonus] skipped sponsor=${sponsorId} amount=${bonus} reason=${payout.skipReason || 'not_credited'}`
    );
    return 0;
  }

  await insertIncomeTransaction(conn, {
    userId: sponsorId,
    type: 'referral_bonus',
    amount: bonus,
    description: `Direct referral bonus (${bonusPercent}%)`,
    relatedUserId: buyerId,
    payout,
  });

  return bonus;
}

export async function distributeLevelBonus(conn, earnerId, roiAmount, investmentId, payoutDate = null) {
  if (roiAmount <= 0) return 0;

  const createdAt = payoutDate ? `${payoutDate} 00:30:00` : null;

  const [uplines] = await conn.query(
    `SELECT rr.upline_id, rr.level, lbr.percentage
     FROM referral_relations rr
     JOIN level_bonus_rates lbr ON lbr.level = rr.level
     WHERE rr.user_id = ?
     ORDER BY rr.level`,
    [earnerId]
  );

  let totalBonus = 0;

  for (const upline of uplines) {
    const bonus = (roiAmount * Number(upline.percentage)) / 100;
    if (bonus <= 0) continue;

    const payout = await creditUserXit(conn, upline.upline_id, bonus, { skipIfNoWallet: true });
    if (!payout.credited) {
      console.warn(
        `[LevelBonus] skipped upline=${upline.upline_id} level=${upline.level} ` +
          `amount=${bonus} reason=${payout.skipReason || 'not_credited'}`
      );
      continue;
    }

    totalBonus += bonus;

    await insertIncomeTransaction(conn, {
      userId: upline.upline_id,
      type: 'level_bonus',
      amount: bonus,
      description: `Level ${upline.level} ROI bonus`,
      relatedUserId: earnerId,
      investmentId,
      payout,
      createdAt,
    });
  }

  return totalBonus;
}

export async function getDirectLegBusiness(conn, sponsorId) {
  const [directs] = await conn.query(
    'SELECT id, username, total_purchased FROM users WHERE sponsor_id = ? ORDER BY created_at',
    [sponsorId]
  );

  if (directs.length === 0) return [];

  const ids = directs.map((d) => d.id);
  const placeholders = ids.map(() => '?').join(',');

  const [teamRows] = await conn.query(
    `SELECT rr.upline_id AS direct_id, COALESCE(SUM(u.total_purchased), 0) AS team_business
     FROM referral_relations rr
     JOIN users u ON u.id = rr.user_id
     WHERE rr.upline_id IN (${placeholders})
     GROUP BY rr.upline_id`,
    ids
  );

  const teamMap = Object.fromEntries(teamRows.map((r) => [r.direct_id, Number(r.team_business)]));

  return directs.map((d) => {
    const selfBusiness = Number(d.total_purchased || 0);
    const teamBusiness = teamMap[d.id] || 0;
    return {
      user_id: d.id,
      username: d.username,
      self_business: selfBusiness,
      team_business: teamBusiness,
      total_business: selfBusiness + teamBusiness,
    };
  });
}

export async function getRewardTierQualification(conn, userId) {
  const legs = await getDirectLegBusiness(conn, userId);
  const [tiers] = await conn.query('SELECT * FROM reward_tiers ORDER BY min_volume DESC');

  let currentTier = null;
  const tierResults = tiers.map((tier) => {
    const minVolume = Number(tier.min_volume);
    const requiredDirects = Number(tier.required_directs);
    const qualifyingLegs = legs.filter((leg) => leg.total_business >= minVolume);
    const qualified = qualifyingLegs.length >= requiredDirects;

    return {
      tier,
      qualified,
      qualifying_count: qualifyingLegs.length,
      qualifying_legs: qualifyingLegs,
    };
  });

  for (const result of tierResults) {
    if (result.qualified) {
      currentTier = result.tier;
      break;
    }
  }

  return { legs, currentTier, tierResults };
}

export async function getDirectLegRoot(conn, earnerId, sponsorId) {
  let current = earnerId;

  while (current) {
    const [rows] = await conn.query('SELECT id, sponsor_id FROM users WHERE id = ?', [current]);
    const user = rows[0];
    if (!user) return null;
    if (Number(user.sponsor_id) === Number(sponsorId)) {
      return user.id;
    }
    if (!user.sponsor_id) return null;
    current = user.sponsor_id;
  }

  return null;
}

function legQualifiesForTier(legs, directLegId, tier) {
  if (!tier) return false;
  const leg = legs.find((l) => Number(l.user_id) === Number(directLegId));
  return leg ? leg.total_business >= Number(tier.min_volume) : false;
}

export async function previewRewardBonus(conn, earnerId, roiAmount) {
  if (roiAmount <= 0) return { bonus: 0, tierName: null };

  let totalBonus = 0;
  let currentId = earnerId;

  while (true) {
    const [rows] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [currentId]);
    const sponsorId = rows[0]?.sponsor_id;
    if (!sponsorId) break;

    const directLegId = await getDirectLegRoot(conn, earnerId, sponsorId);
    if (directLegId) {
      const { currentTier, legs } = await getRewardTierQualification(conn, sponsorId);
      if (currentTier && legQualifiesForTier(legs, directLegId, currentTier)) {
        totalBonus += (roiAmount * Number(currentTier.percentage)) / 100;
      }
    }

    currentId = sponsorId;
  }

  return { bonus: totalBonus, tierName: null };
}

export async function distributeRewardBonus(conn, earnerId, roiAmount, investmentId, payoutDate = null) {
  if (roiAmount <= 0) return 0;

  const createdAt = payoutDate ? `${payoutDate} 00:30:00` : null;
  let totalPaid = 0;
  let currentId = earnerId;
  let earnerName = null;

  while (true) {
    const [rows] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [currentId]);
    const sponsorId = rows[0]?.sponsor_id;
    if (!sponsorId) break;

    const directLegId = await getDirectLegRoot(conn, earnerId, sponsorId);
    if (directLegId) {
      const { currentTier, legs } = await getRewardTierQualification(conn, sponsorId);
      if (currentTier && legQualifiesForTier(legs, directLegId, currentTier)) {
        const percentage = Number(currentTier.percentage);
        const bonus = (roiAmount * percentage) / 100;

        if (bonus > 0) {
          if (!earnerName) {
            const [earnerRow] = await conn.query('SELECT username FROM users WHERE id = ?', [earnerId]);
            earnerName = earnerRow[0]?.username || 'member';
          }

          const payout = await creditUserXit(conn, sponsorId, bonus, { skipIfNoWallet: true });
          if (!payout.credited) {
            console.warn(
              `[RewardBonus] skipped sponsor=${sponsorId} amount=${bonus} reason=${payout.skipReason || 'not_credited'}`
            );
          } else {
            await insertIncomeTransaction(conn, {
              userId: sponsorId,
              type: 'reward_bonus',
              amount: bonus,
              description: `Reward bonus (${currentTier.tier_name}, ${percentage}% of ${earnerName} ROI)`,
              relatedUserId: earnerId,
              investmentId,
              payout,
              createdAt,
            });

            totalPaid += bonus;
          }
        }
      }
    }

    currentId = sponsorId;
  }

  return totalPaid;
}
