import { getSetting } from './incomeService.js';
import { getBlockchainConfig, isBlockchainMode } from './blockchainService.js';
import { getUserOnChainXitBalance } from './tokenPayoutService.js';

/** Minimum XIT in member wallet required to receive ROI or level income. */
export async function getMinWalletXitForIncome(conn) {
  return parseFloat(await getSetting(conn, 'min_wallet_xit_for_income', '100'));
}

/**
 * Wallet XIT balance used for income eligibility.
 * Blockchain mode: on-chain MetaMask balance. Demo mode: users.xit_balance.
 */
export async function getUserWalletXitBalance(conn, userId, cachedUser = null) {
  let user = cachedUser;
  if (!user) {
    const [rows] = await conn.query(
      'SELECT id, xit_balance, wallet_address FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (!rows.length) return 0;
    user = rows[0];
  }

  const config = await getBlockchainConfig(conn);
  if (isBlockchainMode(config.platformMode)) {
    if (!user.wallet_address) return 0;
    return getUserOnChainXitBalance(conn, user.wallet_address);
  }

  return Number(user.xit_balance || 0);
}

export async function userMeetsMinWalletForIncome(conn, userId, cachedUser = null) {
  const min = await getMinWalletXitForIncome(conn);
  const balance = await getUserWalletXitBalance(conn, userId, cachedUser);
  return balance >= min;
}

export async function getWalletIncomeEligibility(conn, userId, cachedUser = null) {
  const min = await getMinWalletXitForIncome(conn);
  const balance = await getUserWalletXitBalance(conn, userId, cachedUser);
  return {
    eligible: balance >= min,
    balance,
    minRequired: min,
  };
}
