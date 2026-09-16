import { findSellOrderByXitHash, findOpenSellOrderForUser } from './sellOrderService.js';
import { restoreInvestmentSellable, resolveFlexibleRestoreInvestmentId } from './sellBalanceService.js';
import { isBlockchainMode, getBlockchainConfig } from './blockchainService.js';

const OPEN_SELL_STATUSES = new Set(['xit_received', 'payout_failed', 'payout_submitted']);

function applySellOrderSplit(sellOrder, amount) {
  const fromInv = Number(sellOrder.amount_from_investments) || 0;
  const fromBal = Number(sellOrder.amount_from_xit_balance) || 0;

  let planRestore = Math.min(amount, fromInv);
  let remainder = Math.max(0, amount - planRestore);
  let walletRestore = Math.min(remainder, fromBal);
  remainder = Math.max(0, remainder - walletRestore);
  if (remainder > 0) {
    planRestore += remainder;
  }

  let onChainAmount = 0;
  if (OPEN_SELL_STATUSES.has(sellOrder.status)) {
    onChainAmount = Math.min(amount, Number(sellOrder.token_amount) || amount);
  }

  let targetInvId = null;
  if (sellOrder.investment_id && planRestore > 0) {
    targetInvId = Number(sellOrder.investment_id);
  }

  return { planRestore, walletRestore, onChainAmount, targetInvId };
}

/**
 * Sell failed: restore flexible/plan + return XIT on-chain (chain mode) so Sellable + Flexible both update.
 * Open sell order is auto-linked by member — tx hash optional.
 */
export async function applySellFailedCompensation(conn, { userId, tokenAmount, refTxHash, investmentId }) {
  const amount = Number(tokenAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid compensation amount');
  }

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  let sellOrder = null;
  let sellOrderAutoLinked = false;
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

  if (!sellOrder) {
    sellOrder = await findOpenSellOrderForUser(conn, userId, amount);
    sellOrderAutoLinked = Boolean(sellOrder);
  }

  let planRestore = amount;
  let walletRestore = 0;
  let onChainAmount = 0;
  let targetInvId = null;

  if (sellOrder) {
    if (Number(sellOrder.user_id) !== Number(userId)) {
      throw new Error('Sell order belongs to another member');
    }
    if (sellOrder.status === 'completed') {
      throw new Error('This sell is already completed (USDT paid).');
    }
    const split = applySellOrderSplit(sellOrder, amount);
    planRestore = split.planRestore;
    walletRestore = split.walletRestore;
    onChainAmount = split.onChainAmount;
    targetInvId = split.targetInvId;
  } else if (chainMode) {
    planRestore = amount;
    onChainAmount = amount;
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
    sellOrderAutoLinked,
  };
}
