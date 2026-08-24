import { getBlockchainConfig, isBlockchainMode, sendTokenPayout, getWalletTokenBalance } from './blockchainService.js';

/**
 * Credit XIT to a user — on-chain transfer in testnet/real, DB xit_balance in demo.
 */
export async function creditUserXit(conn, userId, amount) {
  if (amount <= 0) {
    return { credited: 0, txHash: null, chainId: null, onChainStatus: 'demo', chainMode: false };
  }

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  const [users] = await conn.query('SELECT wallet_address FROM users WHERE id = ?', [userId]);
  const walletAddress = users[0]?.wallet_address;

  let txHash = null;
  let chainId = null;
  let onChainStatus = 'demo';

  if (chainMode) {
    if (!walletAddress) {
      throw new Error('Link your MetaMask wallet to receive on-chain XIT income');
    }
    const payout = await sendTokenPayout(conn, walletAddress, amount);
    txHash = payout.txHash;
    chainId = payout.chainId;
    onChainStatus = 'confirmed';
  } else {
    await conn.query('UPDATE users SET xit_balance = xit_balance + ? WHERE id = ?', [amount, userId]);
  }

  await conn.query('UPDATE users SET total_earned = total_earned + ? WHERE id = ?', [amount, userId]);

  return { credited: amount, txHash, chainId, onChainStatus, chainMode };
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
