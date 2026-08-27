/**
 * Pin BSC mainnet: XIT contract + official Tether USDT payment
 * Usage: node scripts/configureMainnetXitUsdt.js
 */
import '../loadEnv.js';
import { pool } from '../db.js';

const XIT = '0x5bd95D6605cE909D6455D487BEaAD10d3f8F7A17';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

const updates = [
  ['platform_mode', 'real', 'Platform mode: demo, testnet, or real'],
  ['chain_id', '56', 'BSC mainnet'],
  ['chain_name', 'BNB Smart Chain', 'Network name'],
  ['rpc_url', 'https://bsc-dataseed.binance.org/', 'BSC mainnet RPC'],
  ['block_explorer_url', 'https://bscscan.com', 'BscScan'],
  ['bep20_contract_address', XIT, 'XIT BEP-20 on BSC mainnet'],
  ['payment_token_address', USDT, 'Official Tether USDT (BEP-20) on BSC'],
  ['payment_token_symbol', 'USDT', 'Payment symbol'],
  ['payment_decimals', '18', 'USDT decimals on BSC'],
  ['token_price', '0.06', 'Price per XIT in USDT'],
  ['token_name', 'XIT Token', 'Token display name'],
  ['token_symbol', 'XIT', 'Token symbol'],
];

for (const [key, value, description] of updates) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value, description)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), description = VALUES(description)`,
    [key, value, description]
  );
  console.log('OK', key, '=', value);
}

const [rows] = await pool.query(
  `SELECT setting_key, setting_value FROM settings
   WHERE setting_key IN (
     'platform_mode','chain_id','chain_name','rpc_url',
     'bep20_contract_address','payment_token_address','payment_token_symbol',
     'payment_decimals','token_price','admin_treasury_wallet','admin_payout_wallet'
   )
   ORDER BY setting_key`
);
console.log('\n--- Current ---');
for (const r of rows) console.log(`${r.setting_key}=${r.setting_value}`);
await pool.end();
