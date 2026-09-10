INSERT INTO settings (setting_key, setting_value, description)
VALUES (
  'min_wallet_xit_for_income',
  '100',
  'Minimum XIT in member wallet to receive ROI and level income'
)
ON DUPLICATE KEY UPDATE description = VALUES(description);
