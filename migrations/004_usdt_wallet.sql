-- wallet_balance = USDT (buy pay / sell receive)
-- xit_balance = free XIT tokens from ROI & bonuses (outside investment plans)
ALTER TABLE users ADD COLUMN xit_balance DECIMAL(20,8) NOT NULL DEFAULT 0 AFTER wallet_balance;
