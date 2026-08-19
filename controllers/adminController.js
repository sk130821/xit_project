import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import { generateUserToken } from '../middleware/auth.js';

export async function getStats(req, res) {
  try {
    const [totalUsers] = await pool.query('SELECT COUNT(*) as count FROM users');
    const [activeUsers] = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_active = 1');
    const [totalInvested] = await pool.query('SELECT COALESCE(SUM(total_invested), 0) as total FROM users');
    const [totalRoi] = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'roi'");
    const [totalReferral] = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'referral_bonus'");
    const [totalLevelBonus] = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'level_bonus'");
    const [totalRewardBonus] = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'reward_bonus'");

    res.json({
      success: true,
      total_users: totalUsers[0].count,
      active_users: activeUsers[0].count,
      total_invested: Number(totalInvested[0].total),
      total_roi_paid: Number(totalRoi[0].total),
      total_referral_bonus: Number(totalReferral[0].total),
      total_level_bonus: Number(totalLevelBonus[0].total),
      total_reward_bonus: Number(totalRewardBonus[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getUsers(req, res) {
  try {
    const {
      search = '',
      status = 'all',
      sort = 'newest',
      plan_type = 'all',
      min_usdt,
      max_usdt,
      date_from,
      date_to,
    } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
      where += ` AND (
        u.username LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR
        u.wallet_address LIKE ? OR u.referral_code LIKE ? OR s.username LIKE ?
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term);
    }

    if (status === 'active') where += ' AND u.is_active = 1';
    else if (status === 'inactive') where += ' AND u.is_active = 0';
    else if (status === 'invested') where += ' AND u.total_invested > 0';
    else if (status === 'not_invested') where += ' AND u.total_invested = 0';

    if (min_usdt) {
      where += ' AND (u.xit_balance + COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = \'active\'), 0)) >= ?';
      params.push(parseFloat(min_usdt));
    }
    if (max_usdt) {
      where += ' AND (u.xit_balance + COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = \'active\'), 0)) <= ?';
      params.push(parseFloat(max_usdt));
    }
    if (date_from) {
      where += ' AND DATE(u.created_at) >= ?';
      params.push(date_from);
    }
    if (date_to) {
      where += ' AND DATE(u.created_at) <= ?';
      params.push(date_to);
    }

    if (plan_type === 'lock') {
      where += ` AND EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status = 'active' AND i.plan_type = 'lock')`;
    } else if (plan_type === 'flexible') {
      where += ` AND EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status = 'active' AND i.plan_type = 'flexible')`;
    } else if (plan_type === 'both') {
      where += ` AND EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status = 'active' AND i.plan_type = 'lock')`;
      where += ` AND EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status = 'active' AND i.plan_type = 'flexible')`;
    } else if (plan_type === 'none') {
      where += ` AND NOT EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status = 'active')`;
    }

    let orderBy = 'u.created_at DESC';
    if (sort === 'oldest') orderBy = 'u.created_at ASC';
    else if (sort === 'usdt_high' || sort === 'tokens_high') {
      orderBy = '(u.xit_balance + COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = \'active\'), 0)) DESC';
    } else if (sort === 'usdt_low' || sort === 'tokens_low') {
      orderBy = '(u.xit_balance + COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = \'active\'), 0)) ASC';
    }

    const [users] = await pool.query(
      `SELECT u.*, s.username as sponsor_name, s.referral_code as sponsor_code,
        (SELECT COUNT(*) FROM users d WHERE d.sponsor_id = u.id) as direct_count,
        (SELECT COUNT(*) FROM referral_relations rr WHERE rr.upline_id = u.id) as team_size,
        COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = 'active'), 0) as plan_tokens,
        COALESCE((SELECT SUM(i.sellable_amount) FROM investments i WHERE i.user_id = u.id AND i.status = 'active'), 0) as plan_sellable,
        COALESCE((SELECT SUM(i.locked_amount) FROM investments i WHERE i.user_id = u.id AND i.status = 'active'), 0) as plan_locked,
        (SELECT GROUP_CONCAT(DISTINCT i.plan_type ORDER BY i.plan_type SEPARATOR ',')
         FROM investments i WHERE i.user_id = u.id AND i.status = 'active') as plan_types
       FROM users u
       LEFT JOIN users s ON s.id = u.sponsor_id
       ${where}
       ORDER BY ${orderBy}`,
      params
    );

    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(*) as total_members,
        SUM(is_active = 1) as active_members,
        SUM(total_invested > 0) as with_investment,
        COALESCE(SUM(total_purchased), 0) as total_purchased,
        COALESCE(SUM(xit_balance), 0) as total_xit_free,
        COALESCE((SELECT SUM(i.sellable_amount + i.locked_amount) FROM investments i WHERE i.status = 'active'), 0) as total_plan_tokens
       FROM users`
    );

    const summary = summaryRows[0];

    res.json({
      summary: {
        total_members: Number(summary.total_members),
        active_members: Number(summary.active_members),
        with_investment: Number(summary.with_investment),
        total_purchased: Number(summary.total_purchased),
        total_xit_free: Number(summary.total_xit_free),
        total_plan_tokens: Number(summary.total_plan_tokens),
        total_xit: Number(summary.total_xit_free) + Number(summary.total_plan_tokens),
      },
      users: users.map((u) => {
        const xitBalance = Number(u.xit_balance || 0);
        const planTokens = Number(u.plan_tokens || 0);
        return {
          id: u.id,
          username: u.username,
          email: u.email,
          phone: u.phone,
          wallet_address: u.wallet_address,
          referral_code: u.referral_code,
          xit_balance: xitBalance,
          plan_tokens: planTokens,
          plan_sellable: Number(u.plan_sellable || 0),
          plan_locked: Number(u.plan_locked || 0),
          total_xit: xitBalance + planTokens,
          plan_types: u.plan_types ? u.plan_types.split(',') : [],
          total_earned: Number(u.total_earned),
          total_invested: Number(u.total_invested),
          total_purchased: Number(u.total_purchased || 0),
          is_active: !!u.is_active,
          created_at: u.created_at,
          sponsor_name: u.sponsor_name || null,
          sponsor_code: u.sponsor_code || null,
          direct_count: Number(u.direct_count),
          team_size: Number(u.team_size),
          member_status: Number(u.total_invested) > 0 ? 'invested' : 'not_invested',
        };
      }),
    });
  } catch (err) {
    console.error('getUsers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getUserDetail(req, res) {
  try {
    const userId = parseInt(req.params.id);
    if (!userId) return res.status(400).json({ error: 'Invalid user id' });

    const [users] = await pool.query(
      `SELECT u.*, s.username as sponsor_name, s.referral_code as sponsor_code
       FROM users u
       LEFT JOIN users s ON s.id = u.sponsor_id
       WHERE u.id = ?`,
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });

    const u = users[0];

    const [directCount] = await pool.query('SELECT COUNT(*) as c FROM users WHERE sponsor_id = ?', [userId]);
    const [teamCount] = await pool.query('SELECT COUNT(*) as c FROM referral_relations WHERE upline_id = ?', [userId]);

    const [investments] = await pool.query(
      'SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    const incomeTypes = ['roi', 'referral_bonus', 'level_bonus', 'reward_bonus', 'commission'];
    const [incomeTxs] = await pool.query(
      `SELECT * FROM transactions WHERE user_id = ? AND type IN (?) ORDER BY created_at DESC LIMIT 100`,
      [userId, incomeTypes]
    );

    const [buyCount] = await pool.query(
      "SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND type = 'buy'",
      [userId]
    );

    const totalIncome = incomeTxs.reduce((sum, t) => sum + Number(t.amount), 0);

    const [team] = await pool.query(
      `SELECT u.id, u.username, u.email, u.referral_code, u.total_invested, u.total_purchased,
              u.is_active, u.created_at, rr.level
       FROM referral_relations rr
       JOIN users u ON u.id = rr.user_id
       WHERE rr.upline_id = ?
       ORDER BY rr.level, u.created_at DESC`,
      [userId]
    );

    res.json({
      user: {
        id: u.id,
        username: u.username,
        email: u.email,
        phone: u.phone,
        wallet_address: u.wallet_address,
        referral_code: u.referral_code,
        wallet_balance: Number(u.wallet_balance),
        xit_balance: Number(u.xit_balance || 0),
        total_earned: Number(u.total_earned),
        total_invested: Number(u.total_invested),
        total_purchased: Number(u.total_purchased || 0),
        is_active: !!u.is_active,
        created_at: u.created_at,
        sponsor_name: u.sponsor_name || null,
        sponsor_code: u.sponsor_code || null,
        direct_count: Number(directCount[0].c),
        team_size: Number(teamCount[0].c),
        member_status: Number(u.total_invested) > 0 ? 'invested' : 'not_invested',
        buy_tx_count: Number(buyCount[0].c),
        total_income: totalIncome,
      },
      investments: investments.map((inv) => ({
        ...inv,
        token_amount: Number(inv.token_amount),
        total_return: Number(inv.total_return),
        daily_roi_rate: Number(inv.daily_roi_rate),
        roi_received: Number(inv.roi_received),
        sellable_amount: Number(inv.sellable_amount),
        locked_amount: Number(inv.locked_amount),
      })),
      income: incomeTxs.map((t) => ({ ...t, amount: Number(t.amount) })),
      team: team.map((m) => ({
        id: m.id,
        username: m.username,
        email: m.email,
        referral_code: m.referral_code,
        total_invested: Number(m.total_invested),
        total_purchased: Number(m.total_purchased || 0),
        is_active: !!m.is_active,
        created_at: m.created_at,
        level: m.level,
      })),
    });
  } catch (err) {
    console.error('getUserDetail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function loginAsUser(req, res) {
  try {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [targetId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = users[0];
    const token = generateUserToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        wallet_address: user.wallet_address,
        referral_code: user.referral_code,
        wallet_balance: Number(user.wallet_balance),
        xit_balance: Number(user.xit_balance || 0),
        total_earned: Number(user.total_earned),
        total_invested: Number(user.total_invested),
        is_active: !!user.is_active,
      },
    });
  } catch (err) {
    console.error('loginAsUser error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function changeUserPassword(req, res) {
  try {
    const { targetId, password } = req.body;
    if (!targetId || !password) {
      return res.status(400).json({ error: 'targetId and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, targetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('changeUserPassword error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function creditDebit(req, res) {
  const conn = await pool.getConnection();
  try {
    const { targetId, amount, action } = req.body;

    if (!targetId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    if (action !== 'credit' && action !== 'debit') {
      return res.status(400).json({ error: 'Invalid action' });
    }

    await conn.beginTransaction();

    if (action === 'credit') {
      await conn.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amount, targetId]);
    } else {
      await conn.query('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [amount, targetId]);
    }

    const txType = action === 'credit' ? 'admin_credit' : 'admin_debit';
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)',
      [targetId, txType, amount, `Admin ${action} by ${req.adminEmail}`]
    );

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
}

export async function toggleActivation(req, res) {
  try {
    const { targetId, activate } = req.body;

    await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [activate ? 1 : 0, targetId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function updateLevelBonus(req, res) {
  try {
    const { level, percentage } = req.body;

    if (level < 1 || level > 15) {
      return res.status(400).json({ error: 'Level must be 1-15' });
    }

    await pool.query('UPDATE level_bonus_rates SET percentage = ? WHERE level = ?', [percentage, level]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function updateRewardTier(req, res) {
  try {
    const { id, tierName, minVolume, requiredDirects, percentage } = req.body;

    await pool.query(
      'UPDATE reward_tiers SET tier_name = ?, min_volume = ?, required_directs = ?, percentage = ? WHERE id = ?',
      [tierName, minVolume, requiredDirects, percentage, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export async function updateSetting(req, res) {
  try {
    const { key, value } = req.body;

    await pool.query(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value]
    );
    res.json({ success: true });
  } catch (err) {
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
