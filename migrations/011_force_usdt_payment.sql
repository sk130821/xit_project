-- Force USDT (BEP-20) payments on BSC for buys — disable native BNB path defaults
INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('payment_token_address', '0x55d398326f99059fF775485246999027B3197955', 'BEP-20 USDT on BSC mainnet'),
  ('payment_token_symbol', 'USDT', 'Payment token symbol'),
  ('payment_decimals', '18', 'USDT decimals on BSC'),
  ('chain_id', '56', 'BSC mainnet'),
  ('chain_name', 'BNB Smart Chain', 'Network name'),
  ('rpc_url', 'https://bsc-dataseed.binance.org/', 'BSC mainnet RPC'),
  ('block_explorer_url', 'https://bscscan.com', 'BscScan')
ON DUPLICATE KEY UPDATE
  setting_value = VALUES(setting_value),
  description = VALUES(description);

-- If still on empty/BNB symbol, force USDT mainnet contract
UPDATE settings SET setting_value = '0x55d398326f99059fF775485246999027B3197955'
WHERE setting_key = 'payment_token_address'
  AND (setting_value IS NULL OR setting_value = '' OR LOWER(setting_value) = 'bnb');

UPDATE settings SET setting_value = 'USDT' WHERE setting_key = 'payment_token_symbol';
UPDATE settings SET setting_value = '18' WHERE setting_key = 'payment_decimals';
