import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { generateUserToken } from '../middleware/auth.js';
import { getSetting } from '../services/incomeService.js';
import { getBlockchainConfig } from '../services/blockchainService.js';

function generateReferralCode(userId) {
  const base = userId.toString(16).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (base + random).substring(0, 8).padEnd(8, 'X');
}

async function buildReferralChain(userId, sponsorId) {
  if (!sponsorId) return;

  await pool.query(
    'INSERT INTO referral_relations (user_id, upline_id, level) VALUES (?, ?, 1)',
    [userId, sponsorId]
  );

  const [uplines] = await pool.query(
    'SELECT upline_id, level FROM referral_relations WHERE user_id = ? AND level < 15',
    [sponsorId]
  );

  for (const row of uplines) {
    await pool.query(
      'INSERT INTO referral_relations (user_id, upline_id, level) VALUES (?, ?, ?)',
      [userId, row.upline_id, row.level + 1]
    );
  }
}

export async function verifyReferralCode(req, res) {
  try {
    const code = (req.query.code || req.body?.code || '').toString().trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ valid: false, error: 'Referral code is required' });
    }

    const [sponsor] = await pool.query(
      'SELECT id, username, referral_code, is_active FROM users WHERE referral_code = ?',
      [code]
    );

    if (sponsor.length === 0) {
      return res.status(404).json({ valid: false, error: 'Invalid referral code' });
    }

    if (!sponsor[0].is_active) {
      return res.status(400).json({
        valid: false,
        error: 'This sponsor account is pending activation. Use an active member\'s referral code.',
      });
    }

    res.json({
      valid: true,
      sponsor: {
        username: sponsor[0].username,
        referral_code: sponsor[0].referral_code,
      },
    });
  } catch (err) {
    console.error('Verify referral error:', err);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
}

export async function signup(req, res) {
  try {
    const { username, email, password, referralCode } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (!referralCode || !String(referralCode).trim()) {
      return res.status(400).json({ error: 'Referral code is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const [sponsor] = await pool.query(
      'SELECT id, username, is_active FROM users WHERE referral_code = ?',
      [String(referralCode).trim().toUpperCase()]
    );

    if (sponsor.length === 0) {
      return res.status(400).json({ error: 'Invalid referral code. Please check and try again.' });
    }

    if (!sponsor[0].is_active) {
      return res.status(400).json({
        error: 'This sponsor account is not activated yet. Please use an active member\'s referral code.',
      });
    }

    const sponsorId = sponsor[0].id;

    const hashedPassword = await bcrypt.hash(password, 10);

    const config = await getBlockchainConfig(pool);
    let walletBalance = 0;
    if (config.platformMode === 'demo') {
      walletBalance = parseFloat(await getSetting(pool, 'demo_signup_usdt', '1000'));
    }

    const [result] = await pool.query(
      'INSERT INTO users (username, email, password, sponsor_id, referral_code, wallet_balance) VALUES (?, ?, ?, ?, ?, ?)',
      [username, email, hashedPassword, sponsorId, 'TEMP', walletBalance]
    );

    const userId = result.insertId;
    const code = generateReferralCode(userId);
    await pool.query('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);

    await buildReferralChain(userId, sponsorId);

    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
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
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error during signup' });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

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
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
}

export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, users[0].password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function getMe(req, res) {
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    const [invStats] = await pool.query(
      `SELECT
        COALESCE(SUM(sellable_amount), 0) AS plan_sellable,
        COALESCE(SUM(locked_amount), 0) AS plan_locked
       FROM investments WHERE user_id = ? AND status = 'active'`,
      [req.userId]
    );

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      wallet_address: user.wallet_address,
      referral_code: user.referral_code,
      sponsor_id: user.sponsor_id,
      wallet_balance: Number(user.wallet_balance),
      xit_balance: Number(user.xit_balance || 0),
      total_earned: Number(user.total_earned),
      total_invested: Number(user.total_invested),
      total_purchased: Number(user.total_purchased || 0),
      plan_sellable: Number(invStats[0].plan_sellable),
      plan_locked: Number(invStats[0].plan_locked),
      is_active: !!user.is_active,
      created_at: user.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}
