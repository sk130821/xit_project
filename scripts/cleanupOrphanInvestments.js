/**
 * Delete investments whose user no longer exists.
 * Usage: node scripts/cleanupOrphanInvestments.js
 */
import '../loadEnv.js';
import mysql from 'mysql2/promise';

const c = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
});

const [before] = await c.query(`
  SELECT i.id, i.user_id, i.status, i.token_amount
  FROM investments i
  LEFT JOIN users u ON u.id = i.user_id
  WHERE u.id IS NULL
  ORDER BY i.id
`);

console.log('Orphan investments found:', before.length);
for (const r of before) {
  console.log(`  inv#${r.id} user_id=${r.user_id} status=${r.status} amt=${r.token_amount}`);
}

if (before.length === 0) {
  console.log('Nothing to delete.');
  await c.end();
  process.exit(0);
}

const [txResult] = await c.query(`
  DELETE t FROM transactions t
  INNER JOIN investments i ON i.id = t.investment_id
  LEFT JOIN users u ON u.id = i.user_id
  WHERE u.id IS NULL
`);
console.log('Related transactions cleared/updated:', txResult.affectedRows);

const [invResult] = await c.query(`
  DELETE i FROM investments i
  LEFT JOIN users u ON u.id = i.user_id
  WHERE u.id IS NULL
`);
console.log('Orphan investments deleted:', invResult.affectedRows);

const [active] = await c.query(`
  SELECT i.id, u.username, i.token_amount, i.status
  FROM investments i
  INNER JOIN users u ON u.id = i.user_id
  WHERE i.status = 'active'
  ORDER BY i.id
`);
console.log('Remaining active investments:', active.length);
for (const r of active) {
  console.log(`  inv#${r.id} ${r.username} ${r.token_amount} XIT`);
}

await c.end();
console.log('Done.');
