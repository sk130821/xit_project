import { getBlockchainConfig, isBlockchainMode, sendTokenPayout, getWalletTokenBalance } from './blockchainService.js';

/** Strict positive integer — rejects floats like 1.06 (ROI amounts) so wrong args fail loudly. */
export function toPositiveInt(value, label = 'id') {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (type=number, must be positive integer)`);
    }
    return value;
  }
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (type=${typeof value})`);
  }
  const parsed = parseInt(s, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Credit XIT to a user — on-chain transfer in testnet/real, DB xit_balance in demo.
 */
export async function creditUserXit(conn, userId, amount, options = {}) {
  if (amount <= 0) {
    return { credited: 0, txHash: null, chainId: null, onChainStatus: 'demo', chainMode: false };
  }

  const uid = toPositiveInt(userId, 'userId');
  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  const [users] = await conn.query(
    'SELECT id, username, wallet_address FROM users WHERE id = ? LIMIT 1',
    [uid]
  );

  if (users.length === 0) {
    throw new Error(
      `User id=${uid} not found (env DB_NAME=${process.env.DB_NAME || 'MISSING'})`
    );
  }

  const user = users[0];
  if (Number(user.id) !== uid) {
    throw new Error(
      `User id mismatch: requested=${uid} but row.id=${user.id} username=${user.username}`
    );
  }

  if (options.expectedUsername && options.expectedUsername !== user.username) {
    throw new Error(
      `Username mismatch for userId=${uid}: expected=${options.expectedUsername} got=${user.username}`
    );
  }

  const walletRaw = user.wallet_address;
  const walletAddress = typeof walletRaw === 'string' ? walletRaw.trim() : walletRaw;

  let txHash = null;
  let chainId = null;
  let onChainStatus = 'demo';

  if (chainMode) {
    if (!walletAddress) {
      throw new Error(
        `Link your MetaMask wallet to receive on-chain XIT income | ` +
          `userId=${uid} username=${user.username} walletRaw=NULL ` +
          `envDB=${process.env.DB_NAME || 'MISSING'} mode=${config.platformMode}`
      );
    }
    const payout = await sendTokenPayout(conn, walletAddress, amount);
    txHash = payout.txHash;
    chainId = payout.chainId;
    onChainStatus = 'confirmed';
  } else {
    await conn.query('UPDATE users SET xit_balance = xit_balance + ? WHERE id = ?', [amount, uid]);
  }

  await conn.query('UPDATE users SET total_earned = total_earned + ? WHERE id = ?', [amount, uid]);

  return {
    credited: amount,
    txHash,
    chainId,
    onChainStatus,
    chainMode,
    userId: uid,
    username: user.username,
  };
}

/** Max sellable in blockchain mode: plan sellable + ROI/bonus on wallet, capped by on-chain balance. */
export function computeBlockchainSellable(onChainBalance, planSellable, planLocked) {
  const balance = Number(onChainBalance) || 0;
  const sellable = Number(planSellable) || 0;
  const locked = Number(planLocked) || 0;
  const incomeSellable = Math.max(0, balance - sellable - locked);
  return Math.min(balance, sellable + incomeSellable);
}

export async function getUserOnChainXitBalance(conn, walletAddress) {
  if (!walletAddress) return 0;
  const balance = await getWalletTokenBalance(conn, walletAddress);
  return balance === null ? 0 : parseFloat(balance);
}
