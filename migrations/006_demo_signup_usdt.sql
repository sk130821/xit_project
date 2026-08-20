INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('demo_signup_usdt', '1000', 'Demo mode: USDT wallet credited on signup and auto top-up for testing')
ON DUPLICATE KEY UPDATE
  description = VALUES(description);
