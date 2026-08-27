/**
 * Apply USDT payment settings (BSC mainnet defaults).
 * Usage: node scripts/forceUsdtPayment.js
 */
import '../loadEnv.js';
import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '../migrations/011_force_usdt_payment.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const statements = sql
  .split(';')
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);

for (const stmt of statements) {
  try {
    await pool.query(stmt);
    console.log('OK:', stmt.slice(0, 70).replace(/\s+/g, ' '), '...');
  } catch (err) {
    console.error('ERR:', err.message);
  }
}

const [rows] = await pool.query(
  `SELECT setting_key, setting_value FROM settings
   WHERE setting_key IN (
     'platform_mode','payment_token_address','payment_token_symbol',
     'payment_decimals','chain_id','chain_name','rpc_url','token_price'
   ) ORDER BY setting_key`
);
console.log('\nCurrent payment settings:');
for (const r of rows) console.log(`  ${r.setting_key} = ${r.setting_value}`);
await pool.end();
