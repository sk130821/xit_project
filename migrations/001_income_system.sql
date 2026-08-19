USE xit_token;

ALTER TABLE users ADD COLUMN total_purchased DECIMAL(20,8) NOT NULL DEFAULT 0;

ALTER TABLE transactions MODIFY type ENUM(
  'buy','sell','invest','roi','referral_bonus','level_bonus','reward_bonus',
  'commission','admin_credit','admin_debit','withdraw'
) NOT NULL;

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
  ('referral_bonus_percent', '5', 'Direct sponsor referral bonus percentage on token purchase'),
  ('min_referral_purchase', '100', 'Minimum token purchase for referral bonus to trigger')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
