-- ============================================================
-- XIT on BSC Mainnet + Tether USDT payment
-- phpMyAdmin: database xittoken_db select karke poora chalao
-- ============================================================

UPDATE settings SET setting_value = 'real' WHERE setting_key = 'platform_mode';
UPDATE settings SET setting_value = '56' WHERE setting_key = 'chain_id';
UPDATE settings SET setting_value = 'BNB Smart Chain' WHERE setting_key = 'chain_name';
UPDATE settings SET setting_value = 'https://bsc-dataseed.binance.org/' WHERE setting_key = 'rpc_url';
UPDATE settings SET setting_value = 'https://bscscan.com' WHERE setting_key = 'block_explorer_url';

-- Client XIT token (BSC mainnet)
UPDATE settings
SET setting_value = '0x5bd95D6605cE909D6455D487BEaAD10d3f8F7A17'
WHERE setting_key = 'bep20_contract_address';

-- Official Tether USDT (BEP-20) on BSC — not ERC20 Ethereum USDT
UPDATE settings
SET setting_value = '0x55d398326f99059fF775485246999027B3197955'
WHERE setting_key = 'payment_token_address';

UPDATE settings SET setting_value = 'USDT' WHERE setting_key = 'payment_token_symbol';
UPDATE settings SET setting_value = '18' WHERE setting_key = 'payment_decimals';
UPDATE settings SET setting_value = '0.06' WHERE setting_key = 'token_price';
UPDATE settings SET setting_value = 'XIT Token' WHERE setting_key = 'token_name';
UPDATE settings SET setting_value = 'XIT' WHERE setting_key = 'token_symbol';

INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('platform_mode', 'real', 'real = BSC mainnet'),
  ('chain_id', '56', 'BSC mainnet'),
  ('chain_name', 'BNB Smart Chain', 'Network'),
  ('rpc_url', 'https://bsc-dataseed.binance.org/', 'BSC RPC'),
  ('block_explorer_url', 'https://bscscan.com', 'Explorer'),
  ('bep20_contract_address', '0x5bd95D6605cE909D6455D487BEaAD10d3f8F7A17', 'XIT BEP-20 mainnet'),
  ('payment_token_address', '0x55d398326f99059fF775485246999027B3197955', 'Tether USDT BEP-20'),
  ('payment_token_symbol', 'USDT', 'USDT'),
  ('payment_decimals', '18', 'decimals'),
  ('token_price', '0.06', '1 XIT = 0.06 USDT')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

SELECT setting_key, setting_value FROM settings
WHERE setting_key IN (
  'platform_mode','chain_id','bep20_contract_address','payment_token_address',
  'payment_token_symbol','token_price','admin_treasury_wallet','admin_payout_wallet'
)
ORDER BY setting_key;
