-- Wallet-first auth: email/password optional; wallet unique identity
ALTER TABLE users
  MODIFY email VARCHAR(255) NULL UNIQUE,
  MODIFY password VARCHAR(255) NULL;

-- Normalize + unique wallet (lowercase). Ignore if index already exists.
ALTER TABLE users
  ADD UNIQUE INDEX uq_users_wallet_address (wallet_address);
