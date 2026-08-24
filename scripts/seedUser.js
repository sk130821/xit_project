import '../loadEnv.js';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

function generateReferralCode(userId) {
  const base = userId.toString(16).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (base + random).substring(0, 8).padEnd(8, 'X');
}

async function seedUser() {
  const username = process.env.SEED_USER_USERNAME || 'demouser';
  const email = (process.env.SEED_USER_EMAIL || 'user@xit.com').toLowerCase();
  const password = process.env.SEED_USER_PASSWORD || 'User@123';
  const walletBalance = parseFloat(process.env.SEED_USER_BALANCE || '1000');
  const isActive = process.env.SEED_USER_ACTIVE !== 'false';

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'xit_token',
  });

  const [existing] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    console.log(`User already exists: ${email}`);
    await connection.end();
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const [result] = await connection.query(
    'INSERT INTO users (username, email, password, referral_code, wallet_balance, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashedPassword, 'TEMP', walletBalance, isActive ? 1 : 0]
  );

  const userId = result.insertId;
  const referralCode = generateReferralCode(userId);
  await connection.query('UPDATE users SET referral_code = ? WHERE id = ?', [referralCode, userId]);

  console.log('Test user seeded successfully!');
  console.log('-----------------------------');
  console.log(`Email:         ${email}`);
  console.log(`Password:      ${password}`);
  console.log(`Username:      ${username}`);
  console.log(`Referral Code: ${referralCode}`);
  console.log(`USDT Wallet:   ${walletBalance} USDT`);
  console.log(`Active:        ${isActive ? 'Yes' : 'No'}`);
  console.log('Login at:      http://localhost:5173/login');

  await connection.end();
}

seedUser().catch((err) => {
  console.error('User seed failed:', err.message);
  process.exit(1);
});
