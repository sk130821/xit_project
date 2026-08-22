import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';

const code = process.argv[2] || '2J2UFXXX';
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const [users] = await conn.query('SELECT * FROM users WHERE referral_code = ?', [code]);
if (!users.length) {
  console.log('User not found:', code);
  process.exit(1);
}
const u = users[0];
console.log('MEMBER', { id: u.id, username: u.username, total_purchased: u.total_purchased, xit_balance: u.xit_balance, total_earned: u.total_earned });

const [directs] = await conn.query(
  'SELECT id, username, total_purchased FROM users WHERE sponsor_id = ?',
  [u.id]
);
console.log('DIRECTS', directs);

const [directStats] = await conn.query(
  'SELECT COUNT(*) as c, COALESCE(SUM(total_purchased),0) as vol FROM users WHERE sponsor_id = ?',
  [u.id]
);
console.log('DIRECT_STATS', directStats[0]);

const [tiers] = await conn.query('SELECT * FROM reward_tiers ORDER BY min_volume DESC');
let tier = null;
for (const t of tiers) {
  if (Number(directStats[0].c) >= t.required_directs && Number(directStats[0].vol) >= Number(t.min_volume)) {
    tier = t;
    break;
  }
}
console.log('REWARD_TIER', tier);

const [rewards] = await conn.query(
  "SELECT amount, description, created_at FROM transactions WHERE user_id = ? AND type = 'reward_bonus' ORDER BY created_at DESC LIMIT 10",
  [u.id]
);
console.log('REWARD_TXS', rewards);

const [teamByLevel] = await conn.query(
  `SELECT rr.level, COUNT(*) as members, COALESCE(SUM(u.total_purchased),0) as self_business
   FROM referral_relations rr JOIN users u ON u.id = rr.user_id
   WHERE rr.upline_id = ? GROUP BY rr.level ORDER BY rr.level`,
  [u.id]
);
console.log('TEAM_BY_LEVEL', teamByLevel);

await conn.end();
