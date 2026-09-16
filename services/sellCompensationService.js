import { findSellOrderByXitHash } from './sellOrderService.js';
import { restoreInvestmentSellable, resolveFlexibleRestoreInvestmentId } from './sellBalanceService.js';
import { isBlockchainMode, getBlockchainConfig } from './blockchainService.js';

const OPEN_SELL_STATUSES = new Set(['xit_received', 'payout_failed', 'payout_submitted']);

/**
 * Sell failed: restore plan sellable (flexible / targeted investment), optional on-chain return when XIT tx ref exists.
 * Does not blindly credit wallet — avoids Holdings + Sellable inflation without Flexible plan update.
 */
export async function applySellFailedCompensation(conn, { userId, tokenAmount, refTxHash, investmentId }) {
  const amount = Number(tokenAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid compensation amount');
  }

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  let sellOrder = null;
  const ref = refTxHash ? String(refTxHash).trim() : '';
  if (ref && /^0x[a-fA-F0-9]{64}$/.test(ref)) {
    sellOrder = await findSellOrderByXitHash(conn, ref);
    if (sellOrder && Number(sellOrder.user_id) !== Number(userId)) {
      throw new Error('Sell order belongs to another member');
    }
    if (sellOrder && sellOrder.status === 'completed') {
      throw new Error('This sell is already completed (USDT paid). Use general grant if needed.');
    }
  }

  let planRestore = amount;
  let walletRestore = 0;
  let onChainAmount = 0;
  let targetInvId = null;

  if (sellOrder) {
    const fromInv = Number(sellOrder.amount_from_investments) || 0;
    const fromBal = Number(sellOrder.amount_from_xit_balance) || 0;

    planRestore = Math.min(amount, fromInv);
    let remainder = Math.max(0, amount - planRestore);
    walletRestore = Math.min(remainder, fromBal);
    remainder = Math.max(0, remainder - walletRestore);
    if (remainder > 0) {
      planRestore += remainder;
    }

    if (OPEN_SELL_STATUSES.has(sellOrder.status)) {
      onChainAmount = Math.min(amount, Number(sellOrder.token_amount) || amount);
    }
    if (sellOrder.investment_id && planRestore > 0) {
      targetInvId = Number(sellOrder.investment_id);
    }
  }

  if (planRestore > 0) {
    targetInvId = await resolveFlexibleRestoreInvestmentId(conn, userId, targetInvId || investmentId);
    await restoreInvestmentSellable(conn, targetInvId, userId, planRestore);
    await conn.query('UPDATE users SET total_invested = total_invested + ? WHERE id = ?', [planRestore, userId]);
  }

  if (!chainMode && walletRestore > 0) {
    await conn.query('UPDATE users SET xit_balance = xit_balance + ? WHERE id = ?', [walletRestore, userId]);
  }

  return {
    chainMode,
    investmentId: targetInvId,
    planRestored: planRestore,
    walletRestored: walletRestore,
    onChainAmount,
    sellOrderId: sellOrder?.id ?? null,
    sellOrderStatus: sellOrder?.status ?? null,
  };
}
