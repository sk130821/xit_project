USE xit_token;

ALTER TABLE transactions ADD COLUMN tx_hash VARCHAR(66) DEFAULT NULL;
ALTER TABLE transactions ADD COLUMN chain_id INT DEFAULT NULL;
ALTER TABLE transactions ADD COLUMN on_chain_status ENUM('pending','confirmed','failed','demo') DEFAULT NULL;

INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('bep20_contract_address', '', 'XIT BEP-20 token contract address'),
  ('payment_token_address', '', 'Payment token address (empty = native BNB)'),
  ('payment_token_symbol', 'BNB', 'Payment token symbol shown in UI'),
  ('chain_id', '97', 'BSC chain ID (97=testnet, 56=mainnet)'),
  ('chain_name', 'BSC Testnet', 'Blockchain network display name'),
  ('rpc_url', 'https://data-seed-prebsc-1-s1.binance.org:8545/', 'JSON-RPC URL for blockchain verification'),
  ('block_explorer_url', 'https://testnet.bscscan.com', 'Block explorer base URL'),
  ('admin_treasury_wallet', '', 'Admin wallet that receives buy payments'),
  ('admin_payout_wallet', '', 'Admin wallet for sell payouts (uses treasury if empty)'),
  ('token_decimals', '18', 'XIT token decimal places'),
  ('payment_decimals', '18', 'Payment token decimal places (18=BNB, 6=USDT)'),
  ('token_name', 'XIT Token', 'Token display name'),
  ('token_symbol', 'XIT', 'Token symbol'),
  ('liquidity_amount', '0', 'Admin-set liquidity pool amount for display')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
