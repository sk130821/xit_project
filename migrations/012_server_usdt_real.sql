-- ============================================================
-- XIT Token — Server DB: Real mode + Official USDT only
-- Database: xittoken_db (phpMyAdmin me ye DB select karke chalao)
-- ============================================================

-- 1) Platform = real (mainnet)
UPDATE settings SET setting_value = 'real' WHERE setting_key = 'platform_mode';

-- 2) BSC mainnet network
UPDATE settings SET setting_value = '56' WHERE setting_key = 'chain_id';
UPDATE settings SET setting_value = 'BNB Smart Chain' WHERE setting_key = 'chain_name';
UPDATE settings SET setting_value = 'https://bsc-dataseed.binance.org/' WHERE setting_key = 'rpc_url';
UPDATE settings SET setting_value = 'https://bscscan.com' WHERE setting_key = 'block_explorer_url';

-- 3) Official Binance-Peg USDT only (fake USDT contracts NOT accepted by code)
UPDATE settings
SET setting_value = '0x55d398326f99059fF775485246999027B3197955'
WHERE setting_key = 'payment_token_address';

UPDATE settings SET setting_value = 'USDT' WHERE setting_key = 'payment_token_symbol';
UPDATE settings SET setting_value = '18' WHERE setting_key = 'payment_decimals';

-- 4) Token price (1 XIT = 0.06 USDT) — change if needed
UPDATE settings SET setting_value = '0.06' WHERE setting_key = 'token_price';

-- 5) Agar rows missing hon to insert
INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('platform_mode', 'real', 'Platform mode: demo, testnet, or real'),
  ('chain_id', '56', 'BSC mainnet'),
  ('chain_name', 'BNB Smart Chain', 'Network name'),
  ('rpc_url', 'https://bsc-dataseed.binance.org/', 'BSC mainnet RPC'),
  ('block_explorer_url', 'https://bscscan.com', 'BscScan'),
  ('payment_token_address', '0x55d398326f99059fF775485246999027B3197955', 'Official BSC USDT only'),
  ('payment_token_symbol', 'USDT', 'Payment symbol'),
  ('payment_decimals', '18', 'USDT decimals'),
  ('token_price', '0.06', 'Price per XIT in USDT')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

-- 6) VERIFY (result check karo)
SELECT setting_key, setting_value
FROM settings
WHERE setting_key IN (
  'platform_mode',
  'chain_id',
  'chain_name',
  'rpc_url',
  'payment_token_address',
  'payment_token_symbol',
  'payment_decimals',
  'token_price',
  'admin_treasury_wallet',
  'bep20_contract_address'
)
ORDER BY setting_key;

-- NOTE:
-- admin_treasury_wallet = aapka receive wallet (USDT yahan aayega) — khud set karo
-- bep20_contract_address = XIT mainnet contract — khud set karo
-- Code ab sirf official USDT 0x55d398326f99059fF775485246999027B3197955 accept karta hai
