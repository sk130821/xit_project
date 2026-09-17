-- Per-bucket XIT consumed on each sell (referral → level → reward → flex ROI → flexible principal).

CREATE TABLE IF NOT EXISTS sell_income_allocations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  sell_order_id INT DEFAULT NULL,
  transaction_id INT DEFAULT NULL,
  from_referral DECIMAL(20,8) NOT NULL DEFAULT 0,
  from_level DECIMAL(20,8) NOT NULL DEFAULT 0,
  from_reward DECIMAL(20,8) NOT NULL DEFAULT 0,
  from_flexible_roi DECIMAL(20,8) NOT NULL DEFAULT 0,
  from_flexible_principal DECIMAL(20,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sia_user (user_id),
  INDEX idx_sia_sell_order (sell_order_id),
  INDEX idx_sia_tx (transaction_id)
);
