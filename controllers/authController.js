import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { verifyMessage, getAddress, isAddress } from 'ethers';
import { pool } from '../db.js';
import { generateUserToken } from '../middleware/auth.js';
import { getSetting } from '../services/incomeService.js';
import { getBlockchainConfig, isBlockchainMode } from '../services/blockchainService.js';
import { getUserOnChainXitBalance, computeBlockchainSellable } from '../services/tokenPayoutService.js';
import { sendPasswordResetEmail } from '../services/emailService.js';

const WALLET_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://xittoken.co').replace(/\/$/, '');
}

function generateReferralCode(userId) {
  const base = userId.toString(16).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (base + random).substring(0, 8).padEnd(8, 'X');
}

function normalizeWallet(address) {
  if (!address || !isAddress(address)) return null;
  return getAddress(address).toLowerCase();
}

function usernameFromWallet(wallet) {
  return `user_${wallet.slice(2, 6)}${wallet.slice(-4)}`.toLowerCase();
}

function publicUser(user) {
  return {
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
  };
}

function buildLoginMessage(wallet, timestamp) {
  return (
    `XIT Token Login\n` +
    `Wallet: ${wallet}\n` +
    `Timestamp: ${timestamp}\n` +
    `Only sign this message on xittoken.co to authenticate.`
  );
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
    if (users.length === 0 || !users[0].password) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = generateUserToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
}

/** GET /auth/wallet-status?address=0x... — check if wallet already registered */
export async function walletStatus(req, res) {
  try {
    const wallet = normalizeWallet(req.query.address || req.body?.address);
    if (!wallet) {
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }

    const [users] = await pool.query(
      'SELECT id, username, referral_code, is_active FROM users WHERE LOWER(wallet_address) = ? LIMIT 1',
      [wallet]
    );

    if (users.length === 0) {
      return res.json({ registered: false, needsReferral: true, wallet });
    }

    return res.json({
      registered: true,
      needsReferral: false,
      wallet,
      username: users[0].username,
    });
  } catch (err) {
    console.error('Wallet status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/**
 * POST /auth/wallet-login
 * body: { address, signature, timestamp, referralCode? }
 * - Existing wallet → JWT
 * - New wallet → requires valid referralCode (or ?ref from client)
 */
export async function walletLogin(req, res) {
  try {
    const { address, signature, timestamp, referralCode } = req.body || {};
    const wallet = normalizeWallet(address);

    if (!wallet) {
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }
    if (!signature || timestamp == null) {
      return res.status(400).json({ error: 'Signature and timestamp are required' });
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WALLET_LOGIN_MAX_AGE_MS) {
      return res.status(400).json({ error: 'Login message expired. Please sign again.' });
    }

    const message = buildLoginMessage(wallet, ts);
    let recovered;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (normalizeWallet(recovered) !== wallet) {
      return res.status(400).json({ error: 'Signature does not match wallet' });
    }

    const [existing] = await pool.query(
      'SELECT * FROM users WHERE LOWER(wallet_address) = ? LIMIT 1',
      [wallet]
    );

    if (existing.length > 0) {
      const user = existing[0];
      const token = generateUserToken(user);
      return res.json({
        token,
        isNew: false,
        user: publicUser(user),
      });
    }

    // New member — sponsor required
    const code = (referralCode || '').toString().trim().toUpperCase();
    if (!code) {
      return res.status(400).json({
        error: 'Sponsor referral code is required for first-time wallet connect',
        code: 'NEEDS_REFERRAL',
        needsReferral: true,
      });
    }

    const [sponsor] = await pool.query(
      'SELECT id, username, is_active FROM users WHERE referral_code = ?',
      [code]
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
    const config = await getBlockchainConfig(pool);
    let walletBalance = 0;
    if (config.platformMode === 'demo') {
      walletBalance = parseFloat(await getSetting(pool, 'demo_signup_usdt', '1000'));
    }

    const username = usernameFromWallet(wallet);
    const [result] = await pool.query(
      `INSERT INTO users (username, email, password, sponsor_id, referral_code, wallet_address, wallet_balance, is_active)
       VALUES (?, NULL, NULL, ?, 'TEMP', ?, ?, 0)`,
      [username, sponsorId, wallet, walletBalance]
    );

    const userId = result.insertId;
    const newCode = generateReferralCode(userId);
    await pool.query('UPDATE users SET referral_code = ? WHERE id = ?', [newCode, userId]);
    await buildReferralChain(userId, sponsorId);

    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];
    const token = generateUserToken(user);

    return res.json({
      token,
      isNew: true,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('Wallet login error:', err);
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'This wallet is already registered' });
    }
    res.status(500).json({ error: 'Server error during wallet login' });
  }
}

export async function forgotPassword(req, res) {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const genericMessage = 'If this email is registered, you will receive a password reset link shortly.';

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const [users] = await pool.query('SELECT id, username, email FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      return res.json({ success: true, message: genericMessage });
    }

    const user = users[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${getFrontendUrl()}/reset-password?token=${rawToken}`;

    try {
      await sendPasswordResetEmail({
        toEmail: user.email,
        username: user.username,
        resetUrl,
      });
    } catch (mailErr) {
      console.error('Forgot password email error:', mailErr.message);
      return res.status(503).json({ error: 'Unable to send reset email. Please try again later or contact support@xittoken.co' });
    }

    res.json({ success: true, message: genericMessage });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenHash = hashResetToken(String(token).trim());

    const [rows] = await pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
       FROM password_reset_tokens prt
       WHERE prt.token_hash = ?
       ORDER BY prt.created_at DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const record = rows[0];
    if (record.used_at) {
      return res.status(400).json({ error: 'This reset link has already been used' });
    }
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Reset link has expired. Request a new one.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, record.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [record.id]);
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [record.user_id]);

    res.json({ success: true, message: 'Password updated successfully. You can now login.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
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
    if (!users[0].password) {
      return res.status(400).json({ error: 'Wallet accounts do not use a password. Use Connect Wallet to sign in.' });
    }

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

    const planSellable = Number(invStats[0].plan_sellable);
    const planLocked = Number(invStats[0].plan_locked);

    const conn = await pool.getConnection();
    let platformMode = 'demo';
    let onChainXitBalance = null;
    let totalSellable = null;

    try {
      const config = await getBlockchainConfig(conn);
      platformMode = config.platformMode;
      const chainMode = isBlockchainMode(platformMode);

      if (chainMode && user.wallet_address) {
        onChainXitBalance = await getUserOnChainXitBalance(conn, user.wallet_address);
        totalSellable = computeBlockchainSellable(onChainXitBalance, planSellable, planLocked);
      } else if (!chainMode) {
        totalSellable = Number(user.xit_balance || 0) + planSellable;
      }
    } finally {
      conn.release();
    }

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
      plan_sellable: planSellable,
      plan_locked: planLocked,
      platform_mode: platformMode,
      on_chain_xit_balance: onChainXitBalance,
      total_sellable: totalSellable,
      is_active: !!user.is_active,
      created_at: user.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}
