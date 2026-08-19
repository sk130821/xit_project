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
