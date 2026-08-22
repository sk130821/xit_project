import { pool } from '../db.js';
import { getRewardTierQualification } from '../services/incomeService.js';

export async function getNetwork(req, res) {
  try {
    const userId = req.userId;

    const [members] = await pool.query(
      `SELECT u.id, u.username, u.email, u.wallet_balance, u.is_active, u.created_at,
              u.total_invested, u.total_purchased, u.sponsor_id, rr.level
       FROM referral_relations rr
       JOIN users u ON u.id = rr.user_id
       WHERE rr.upline_id = ?
       ORDER BY rr.level, u.created_at DESC`,
      [userId]
    );

    const memberIds = members.map((m) => m.id);
    let teamBusinessMap = {};

    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      const [teamRows] = await pool.query(
        `SELECT rr.upline_id AS member_id, COALESCE(SUM(u.total_purchased), 0) AS team_business
         FROM referral_relations rr
         JOIN users u ON u.id = rr.user_id
         WHERE rr.upline_id IN (${placeholders})
         GROUP BY rr.upline_id`,
        memberIds
      );
      teamBusinessMap = Object.fromEntries(
        teamRows.map((r) => [r.member_id, Number(r.team_business)])
      );
    }

    const [directStats] = await pool.query(
      `SELECT COUNT(*) AS direct_count,
              COALESCE(SUM(total_purchased), 0) AS direct_self_business
       FROM users WHERE sponsor_id = ?`,
      [userId]
    );

    const mappedMembers = members.map((m) => ({
      user_id: m.id,
      username: m.username,
      email: m.email,
      level: m.level,
      is_direct: Number(m.sponsor_id) === Number(userId),
      wallet_balance: Number(m.wallet_balance),
      is_active: !!m.is_active,
      created_at: m.created_at,
      total_invested: Number(m.total_invested),
      total_purchased: Number(m.total_purchased || 0),
      self_business: Number(m.total_purchased || 0),
      team_business: teamBusinessMap[m.id] || 0,
      total_business: Number(m.total_purchased || 0) + (teamBusinessMap[m.id] || 0),
    }));

    const [levelBonusRates] = await pool.query(
      'SELECT level, percentage FROM level_bonus_rates ORDER BY level'
    );

    const [levelRows] = await pool.query(
      `SELECT rr.level,
              COUNT(DISTINCT rr.user_id) AS members,
              COALESCE(SUM(u.total_purchased), 0) AS self_business,
              COALESCE(SUM(CASE WHEN i.status = 'active' THEN i.token_amount ELSE 0 END), 0) AS active_investment,
              COALESCE(SUM(CASE WHEN i.status = 'active' THEN i.token_amount * i.daily_roi_rate / 100 ELSE 0 END), 0) AS estimated_daily_downline_roi
       FROM referral_relations rr
       JOIN users u ON u.id = rr.user_id
       LEFT JOIN investments i ON i.user_id = u.id AND i.status = 'active'
       WHERE rr.upline_id = ?
       GROUP BY rr.level
       ORDER BY rr.level`,
      [userId]
    );

    const [receivedByLevel] = await pool.query(
      `SELECT rr.level, COALESCE(SUM(t.amount), 0) AS received_level_income
       FROM transactions t
       JOIN referral_relations rr ON rr.user_id = t.related_user_id AND rr.upline_id = ?
       WHERE t.user_id = ? AND t.type = 'level_bonus'
       GROUP BY rr.level`,
      [userId, userId]
    );

    const levelRowMap = Object.fromEntries(levelRows.map((r) => [r.level, r]));
    const receivedMap = Object.fromEntries(
      receivedByLevel.map((r) => [r.level, Number(r.received_level_income)])
    );

    const levelStatsFull = levelBonusRates.map((rate) => {
      const row = levelRowMap[rate.level] || {};
      const membersAtLevel = mappedMembers.filter((m) => m.level === rate.level);
      const teamAtLevel = membersAtLevel.reduce((sum, m) => sum + m.team_business, 0);
      const selfBusiness = Number(row.self_business || 0);
      const pct = Number(rate.percentage);
      const dailyDownlineRoi = Number(row.estimated_daily_downline_roi || 0);

      return {
        level: rate.level,
        members: Number(row.members || 0),
        self_business: selfBusiness,
        team_business: teamAtLevel,
        total_business: selfBusiness + teamAtLevel,
        active_investment: Number(row.active_investment || 0),
        level_bonus_percent: pct,
        estimated_daily_downline_roi: dailyDownlineRoi,
        estimated_daily_level_income: (dailyDownlineRoi * pct) / 100,
        received_level_income: receivedMap[rate.level] || 0,
      };
    });

    const totalSelfBusiness = mappedMembers.reduce((sum, m) => sum + m.self_business, 0);
    const totalTeamDownline = mappedMembers.reduce((sum, m) => sum + m.team_business, 0);
    const totalEstDailyLevelIncome = levelStatsFull.reduce(
      (sum, l) => sum + l.estimated_daily_level_income,
      0
    );

    res.json({
      members: mappedMembers,
      summary: {
        total_members: mappedMembers.length,
        active_members: mappedMembers.filter((m) => m.is_active).length,
        direct_count: Number(directStats[0].direct_count),
        direct_self_business: Number(directStats[0].direct_self_business),
        total_self_business: totalSelfBusiness,
        total_team_business: totalSelfBusiness + totalTeamDownline,
        estimated_daily_level_income: totalEstDailyLevelIncome,
        level_stats: levelStatsFull,
      },
    });
  } catch (err) {
    console.error('Get network error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getTransactions(req, res) {
  try {
    const {
      type,
      category,
      search,
      dateFrom,
      dateTo,
      page = '1',
      limit = '15',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    const incomeTypes = ['roi', 'referral_bonus', 'level_bonus', 'reward_bonus'];
    const params = [req.userId];
    let where = 'WHERE user_id = ?';

    if (category === 'income') {
      where += ` AND type IN (${incomeTypes.map(() => '?').join(', ')})`;
      params.push(...incomeTypes);
    } else if (type && type !== 'all') {
      where += ' AND type = ?';
      params.push(type);
    }

    if (search && String(search).trim()) {
      where += ' AND (description LIKE ? OR type LIKE ? OR CAST(amount AS CHAR) LIKE ?)';
      const term = `%${String(search).trim()}%`;
      params.push(term, term, term);
    }

    if (dateFrom) {
      where += ' AND DATE(created_at) >= ?';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(created_at) <= ?';
      params.push(dateTo);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM transactions ${where}`,
      params
    );
    const total = Number(countRows[0].total);

    const [txs] = await pool.query(
      `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({
      items: txs.map((t) => ({
        ...t,
        amount: Number(t.amount),
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getLevelBonusRates(req, res) {
  try {
    const [rates] = await pool.query('SELECT * FROM level_bonus_rates ORDER BY level');
    res.json(rates.map((r) => ({ ...r, percentage: Number(r.percentage) })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getRewardTiers(req, res) {
  try {
    const [tiers] = await pool.query('SELECT * FROM reward_tiers ORDER BY min_volume');
    res.json(tiers.map((t) => ({
      id: t.id,
      tier_name: t.tier_name,
      min_volume: Number(t.min_volume),
      required_directs: t.required_directs,
      percentage: Number(t.percentage),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getSettings(req, res) {
  try {
    const [settings] = await pool.query('SELECT * FROM settings');
    const map = {};
    for (const s of settings) {
      map[s.setting_key] = s.setting_value;
    }
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getRewardStatus(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const { legs, currentTier, tierResults } = await getRewardTierQualification(conn, req.userId);

      res.json({
        direct_count: legs.length,
        direct_volume: legs.reduce((sum, leg) => sum + leg.total_business, 0),
        direct_legs: legs,
        current_tier: currentTier
          ? {
              id: currentTier.id,
              tier_name: currentTier.tier_name,
              percentage: Number(currentTier.percentage),
            }
          : null,
        tiers: [...tierResults].reverse().map((result) => ({
          id: result.tier.id,
          tier_name: result.tier.tier_name,
          min_volume: Number(result.tier.min_volume),
          required_directs: result.tier.required_directs,
          percentage: Number(result.tier.percentage),
          qualified: result.qualified,
          qualifying_count: result.qualifying_count,
        })),
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Get reward status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}
