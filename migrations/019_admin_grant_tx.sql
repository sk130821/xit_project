-- Admin XIT grant (no USDT) — run once on production DB
ALTER TABLE transactions
  MODIFY COLUMN type ENUM(
    'buy','sell','invest','roi','referral_bonus','level_bonus','reward_bonus',
    'commission','admin_credit','admin_debit','admin_grant','withdraw'
  ) NOT NULL;
