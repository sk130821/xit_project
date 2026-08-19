import { pool } from '../db.js';

export async function getNetwork(req, res) {
  try {
    const [members] = await pool.query(
      `SELECT u.id, u.username, u.email, u.wallet_balance, u.is_active, u.created_at,
              u.total_invested, u.total_purchased, rr.level
       FROM referral_relations rr
       JOIN users u ON u.id = rr.user_id
       WHERE rr.upline_id = ?
       ORDER BY rr.level, u.created_at DESC`,
      [req.userId]
    );

    res.json(members.map((m) => ({
      user_id: m.id,
      username: m.username,
      email: m.email,
      level: m.level,
      wallet_balance: Number(m.wallet_balance),
      is_active: !!m.is_active,
      created_at: m.created_at,
      total_invested: Number(m.total_invested),
      total_purchased: Number(m.total_purchased || 0),
    })));
  } catch (err) {
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
    const [directStats] = await pool.query(
      `SELECT COUNT(*) as direct_count, COALESCE(SUM(total_purchased), 0) as total_volume
       FROM users WHERE sponsor_id = ?`,
      [req.userId]
    );

    const [tiers] = await pool.query('SELECT * FROM reward_tiers ORDER BY min_volume');
    const directCount = Number(directStats[0].direct_count);
    const totalVolume = Number(directStats[0].total_volume);

    let currentTier = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tier = tiers[i];
      if (directCount >= tier.required_directs && totalVolume >= Number(tier.min_volume)) {
        currentTier = {
          id: tier.id,
          tier_name: tier.tier_name,
          percentage: Number(tier.percentage),
        };
        break;
      }
    }

    res.json({
      direct_count: directCount,
      direct_volume: totalVolume,
      current_tier: currentTier,
      tiers: tiers.map((t) => ({
        id: t.id,
        tier_name: t.tier_name,
        min_volume: Number(t.min_volume),
        required_directs: t.required_directs,
        percentage: Number(t.percentage),
        qualified: directCount >= t.required_directs && totalVolume >= Number(t.min_volume),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}
