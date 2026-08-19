export async function getSetting(conn, key, fallback) {
  const [rows] = await conn.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  if (rows.length === 0) return fallback;
  return rows[0].setting_value;
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

  await conn.query(
    'UPDATE users SET xit_balance = xit_balance + ?, total_earned = total_earned + ? WHERE id = ?',
    [bonus, bonus, sponsorId]
  );

  await conn.query(
    'INSERT INTO transactions (user_id, type, amount, description, related_user_id) VALUES (?, ?, ?, ?, ?)',
    [sponsorId, 'referral_bonus', bonus, `Direct referral bonus (${bonusPercent}%)`, buyerId]
  );

  return bonus;
}

export async function distributeLevelBonus(conn, earnerId, roiAmount, investmentId) {
  if (roiAmount <= 0) return 0;

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

    totalBonus += bonus;

    await conn.query(
      'UPDATE users SET xit_balance = xit_balance + ?, total_earned = total_earned + ? WHERE id = ?',
      [bonus, bonus, upline.upline_id]
    );

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description, related_user_id, investment_id) VALUES (?, ?, ?, ?, ?, ?)',
      [upline.upline_id, 'level_bonus', bonus, `Level ${upline.level} ROI bonus`, earnerId, investmentId]
    );
  }

  return totalBonus;
}

export async function calculateRewardBonus(conn, userId, roiAmount) {
  if (roiAmount <= 0) return { bonus: 0, tierName: null };

  const [directStats] = await conn.query(
    `SELECT COUNT(*) as direct_count, COALESCE(SUM(total_purchased), 0) as total_volume
     FROM users WHERE sponsor_id = ?`,
    [userId]
  );

  const directCount = Number(directStats[0].direct_count);
  const totalVolume = Number(directStats[0].total_volume);

  const [tiers] = await conn.query('SELECT * FROM reward_tiers ORDER BY min_volume DESC');

  for (const tier of tiers) {
    if (directCount >= tier.required_directs && totalVolume >= Number(tier.min_volume)) {
      const bonus = (roiAmount * Number(tier.percentage)) / 100;
      return { bonus, tierName: tier.tier_name, tierId: tier.id, percentage: Number(tier.percentage) };
    }
  }

  return { bonus: 0, tierName: null };
}

export async function payRewardBonus(conn, userId, roiAmount, investmentId) {
  const { bonus, tierName, percentage } = await calculateRewardBonus(conn, userId, roiAmount);
  if (bonus <= 0) return 0;

  await conn.query(
    'UPDATE users SET xit_balance = xit_balance + ?, total_earned = total_earned + ? WHERE id = ?',
    [bonus, bonus, userId]
  );

  await conn.query(
    'INSERT INTO transactions (user_id, type, amount, description, investment_id) VALUES (?, ?, ?, ?, ?)',
    [userId, 'reward_bonus', bonus, `Reward bonus (${tierName}, ${percentage}% of ROI)`, investmentId]
  );

  return bonus;
}
