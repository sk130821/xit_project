CREATE DATABASE IF NOT EXISTS xit_token CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE xit_token;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  wallet_address VARCHAR(255) DEFAULT NULL,
  referral_code VARCHAR(20) NOT NULL UNIQUE,
  sponsor_id INT DEFAULT NULL,
  wallet_balance DECIMAL(20,8) NOT NULL DEFAULT 0 COMMENT 'USDT balance for buy/sell',
  xit_balance DECIMAL(20,8) NOT NULL DEFAULT 0 COMMENT 'Free XIT from ROI and bonuses',
  total_earned DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_invested DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_purchased DECIMAL(20,8) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sponsor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_relations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  upline_id INT NOT NULL,
  level INT NOT NULL CHECK (level >= 1 AND level <= 15),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_upline (user_id, upline_id),
  INDEX idx_referral_user (user_id),
  INDEX idx_referral_upline (upline_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (upline_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS investments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  plan_type ENUM('lock','flexible') NOT NULL,
  token_amount DECIMAL(20,8) NOT NULL,
  total_return DECIMAL(20,8) NOT NULL,
  daily_roi_rate DECIMAL(10,8) NOT NULL,
  roi_received DECIMAL(20,8) NOT NULL DEFAULT 0,
  sellable_amount DECIMAL(20,8) NOT NULL DEFAULT 0,
  locked_amount DECIMAL(20,8) NOT NULL DEFAULT 0,
  start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_date DATETIME NOT NULL,
  last_roi_date DATE DEFAULT (CURRENT_DATE),
  status ENUM('active','completed','cancelled') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_investments_user (user_id),
  INDEX idx_investments_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('buy','sell','invest','roi','referral_bonus','level_bonus','reward_bonus','commission','admin_credit','admin_debit','withdraw') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  description TEXT,
  related_user_id INT DEFAULT NULL,
  investment_id INT DEFAULT NULL,
  tx_hash VARCHAR(66) DEFAULT NULL,
  chain_id INT DEFAULT NULL,
  on_chain_status ENUM('pending','confirmed','failed','demo') DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_transactions_user (user_id),
  INDEX idx_transactions_created (created_at),
  INDEX idx_transactions_tx_hash (tx_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (related_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payout_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_type ENUM('auto','manual') NOT NULL DEFAULT 'manual',
  run_date DATE NOT NULL,
  investments_processed INT NOT NULL DEFAULT 0,
  total_roi DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_level_bonus DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_reward_bonus DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_payout DECIMAL(20,8) NOT NULL DEFAULT 0,
  status ENUM('completed','failed') NOT NULL DEFAULT 'completed',
  triggered_by VARCHAR(100) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payout_runs_date (run_date),
  INDEX idx_payout_runs_created (created_at)
);

CREATE TABLE IF NOT EXISTS level_bonus_rates (
  level INT PRIMARY KEY CHECK (level >= 1 AND level <= 15),
  percentage DECIMAL(10,4) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reward_tiers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tier_name VARCHAR(50) NOT NULL,
  min_volume DECIMAL(20,2) NOT NULL,
  required_directs INT NOT NULL DEFAULT 3,
  percentage DECIMAL(10,4) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO level_bonus_rates (level, percentage) VALUES
  (1, 5.0000), (2, 2.5000), (3, 1.2500),
  (4, 0.5000), (5, 0.5000), (6, 0.5000), (7, 0.5000),
  (8, 0.5000), (9, 0.5000), (10, 0.5000),
  (11, 0.2500), (12, 0.2500), (13, 0.2500), (14, 0.2500), (15, 0.2500)
ON DUPLICATE KEY UPDATE percentage = VALUES(percentage);

INSERT INTO reward_tiers (id, tier_name, min_volume, required_directs, percentage) VALUES
  (1, '30K Team', 30000, 3, 2.0000),
  (2, '90K Team', 90000, 3, 3.0000),
  (3, '1.8L Team', 180000, 3, 4.0000),
  (4, '3L Team', 300000, 3, 5.0000),
  (5, '7L Team', 700000, 3, 6.0000),
  (6, '15L Team', 1500000, 3, 7.0000)
ON DUPLICATE KEY UPDATE
  tier_name = VALUES(tier_name),
  min_volume = VALUES(min_volume),
  required_directs = VALUES(required_directs),
  percentage = VALUES(percentage);

INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('platform_mode', 'demo', 'Platform mode: demo, testnet, or real'),
  ('token_price', '1.00', 'Price per XIT token in USD'),
  ('referral_bonus_percent', '5', 'Direct sponsor referral bonus percentage on token purchase'),
  ('min_referral_purchase', '100', 'Minimum token purchase for referral bonus to trigger'),
  ('lock_period_days', '365', 'Lock period in days for lock plan'),
  ('flexible_lock_days', '365', 'Lock period for 20% locked in flexible plan'),
  ('min_purchase', '10', 'Minimum token purchase amount'),
  ('min_investment', '100', 'Minimum investment amount'),
  ('demo_signup_usdt', '1000', 'Demo mode: USDT wallet for new signups and auto top-up'),
  ('admin_charge_percent', '10', 'Admin charge percentage on token sales'),
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
