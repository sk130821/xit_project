-- Purchases under flexible_min_tokens are lock-only with no MLM income on ROI
ALTER TABLE investments
  ADD COLUMN income_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER status;

-- Backfill: sub-100 investments are ROI-only (no level/reward income)
UPDATE investments SET income_eligible = 0 WHERE token_amount < 100;

INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('flexible_min_tokens', '100', 'Minimum tokens for Flexible plan and MLM income eligibility'),
  ('min_purchase', '1', 'Minimum token purchase amount')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

UPDATE settings SET setting_value = '1' WHERE setting_key IN ('min_purchase', 'min_investment');
