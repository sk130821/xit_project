-- Pending sell fail-safe: save XIT receipt before USDT payout.
-- If admin USDT/BNB/gas/RPC fails, the sell stays on record and can be retried.

CREATE TABLE IF NOT EXISTS sell_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  investment_id INT DEFAULT NULL,
  token_amount DECIMAL(20,8) NOT NULL,
  admin_charge DECIMAL(20,8) NOT NULL,
  net_xit DECIMAL(20,8) NOT NULL,
  usdt_payout DECIMAL(20,8) NOT NULL,
  payment_symbol VARCHAR(16) NOT NULL DEFAULT 'USDT',
  amount_from_xit_balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  amount_from_investments DECIMAL(20,8) NOT NULL DEFAULT 0,
  xit_tx_hash VARCHAR(66) NOT NULL,
  payout_tx_hash VARCHAR(66) DEFAULT NULL,
  chain_id INT DEFAULT NULL,
  status ENUM('xit_received','payout_failed','payout_submitted','completed') NOT NULL DEFAULT 'xit_received',
  error_message TEXT,
  transaction_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sell_orders_xit_tx (xit_tx_hash),
  INDEX idx_sell_orders_status (status),
  INDEX idx_sell_orders_user (user_id)
);
