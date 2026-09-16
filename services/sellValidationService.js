import { getSetting } from './incomeService.js';
import {
  getBlockchainConfig,
  isBlockchainMode,
  MIN_USER_BNB_GAS,
  validateAdminSellPayout,
  validateUserSellGas,
} from './blockchainService.js';
import { getUserOnChainXitBalance } from './tokenPayoutService.js';
import {
  allocateSellAmountThreeTier,
  computeChainMemberSellableForUser,
  computeDemoMemberSellable,
  computeWalletIncomeSellableCaps,
  getInvestmentBalanceStats,
  investmentAllowsSell,
  reconcileLegacyXitBalance,
} from './sellBalanceService.js';

/**
 * Validate sell amount against DB + on-chain rules (read-only).
 * Returns payout breakdown or throws with a user-facing message.
 *
 * options.postTransferVerified — XIT already sent on-chain; use wallet balance + tokenAmount
 *   for sellable math (avoid false "insufficient" after MetaMask transfer).
 */
export async function evaluateSellEligibility(conn, userId, tokenAmount, investmentId = null, options = {}) {
  const postTransferVerified = Boolean(options.postTransferVerified);
  if (!tokenAmount || tokenAmount <= 0) {
    throw new Error('Invalid amount');
  }

  const lockSql = options.lock ? ' FOR UPDATE' : '';
  const [users] = await conn.query(`SELECT * FROM users WHERE id = ?${lockSql}`, [userId]);
  if (users.length === 0) {
    throw new Error('User not found');
  }

  const user = users[0];
  if (!user.is_active) {
    throw new Error('Account not activated');
  }

  let xitBalance = Number(user.xit_balance || 0);
  const balanceStats = await getInvestmentBalanceStats(conn, userId);
  const {
    planSellable: sellableFromInvestments,
    planLocked,
    lockRoiHeld,
    flexibleRoi,
  } = balanceStats;

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  if (!chainMode && options.lock) {
    xitBalance = await reconcileLegacyXitBalance(conn, userId, lockRoiHeld, flexibleRoi);
    user.xit_balance = xitBalance;
  }

  let onChainBalance = null;
  if (chainMode && user.wallet_address) {
    onChainBalance = await getUserOnChainXitBalance(conn, user.wallet_address);
  }

  const walletBasis = chainMode && onChainBalance != null ? onChainBalance : xitBalance;
  const planSubtract = chainMode ? sellableFromInvestments : 0;
  const lockedSubtract = chainMode ? planLocked : 0;
  const walletCaps = await computeWalletIncomeSellableCaps(
    conn,
    userId,
    walletBasis,
    lockRoiHeld,
    flexibleRoi,
    planSubtract,
    lockedSubtract
  );

  let totalSellable;
  let amountFromXitBalance = 0;
  let amountFromOtherIncome = 0;
  let amountFromFlexRoi = 0;
  let amountFromInvestments = 0;
  let otherIncomeCap = 0;
  let flexRoiCap = 0;
  let planCap = sellableFromInvestments;
  const targetInvestmentId = investmentId ? Number(investmentId) : null;

  if (targetInvestmentId) {
    const [targetInvs] = await conn.query(
      `SELECT id, sellable_amount, roi_received, plan_type, status, end_date FROM investments WHERE id = ? AND user_id = ?${lockSql}`,
      [targetInvestmentId, userId]
    );
    if (targetInvs.length === 0) {
      throw new Error('Investment not found');
    }
    const targetInv = targetInvs[0];
    if (!investmentAllowsSell(targetInv)) {
      throw new Error('This investment has no sellable tokens');
    }
    const invSellable = Number(targetInv.sellable_amount);
    const invFlexRoi =
      targetInv.plan_type === 'flexible' ? Number(targetInv.roi_received || 0) : 0;
    planCap = invSellable;
    flexRoiCap = invFlexRoi;

    if (chainMode) {
      const chainView = await computeChainMemberSellableForUser(
        conn,
        userId,
        onChainBalance ?? 0,
        sellableFromInvestments,
        planLocked,
        lockRoiHeld,
        flexibleRoi
      );
      otherIncomeCap = chainView.otherIncomeSellable;
    } else {
      otherIncomeCap = walletCaps.otherIncomeCap;
    }

    totalSellable = roundXit(otherIncomeCap + invFlexRoi + invSellable);
    if (totalSellable <= 0) {
      throw new Error('This investment has no sellable tokens');
    }
    if (tokenAmount > totalSellable) {
      throw new Error(`Maximum sellable from this investment is ${totalSellable} XIT`);
    }

    if (chainMode) {
      if (!user.wallet_address) {
        throw new Error('Link your MetaMask wallet before selling in blockchain mode');
      }
      if (!postTransferVerified && tokenAmount > (onChainBalance ?? 0)) {
        throw new Error('Insufficient XIT balance in your wallet');
      }
    }
  } else if (chainMode) {
    if (!user.wallet_address) {
      throw new Error('Link your MetaMask wallet before selling in blockchain mode');
    }

    const chainView = await computeChainMemberSellableForUser(
      conn,
      userId,
      onChainBalance ?? 0,
      sellableFromInvestments,
      planLocked,
      lockRoiHeld,
      flexibleRoi
    );
    totalSellable = chainView.totalSellable;
    otherIncomeCap = chainView.otherIncomeSellable;
    flexRoiCap = chainView.flexibleRoiSellable;
    planCap = chainView.planSellable;

    if (tokenAmount > totalSellable) {
      throw new Error(`Maximum sellable from your plan is ${totalSellable} XIT`);
    }

    if (!postTransferVerified && tokenAmount > (onChainBalance ?? 0)) {
      throw new Error('Insufficient XIT balance in your wallet');
    }
  } else {
    const demoView = await computeDemoMemberSellable(
      conn,
      userId,
      sellableFromInvestments,
      flexibleRoi,
      xitBalance,
      lockRoiHeld
    );
    totalSellable = demoView.totalSellable;
    otherIncomeCap = demoView.otherIncomeSellable;
    flexRoiCap = demoView.flexibleRoiSellable;
    planCap = demoView.planSellable;

    if (tokenAmount > totalSellable) {
      throw new Error('Insufficient sellable XIT tokens');
    }
  }

  ({
    amountFromOtherIncome,
    amountFromFlexRoi,
    amountFromInvestments,
    amountFromXitBalance,
  } = allocateSellAmountThreeTier(tokenAmount, planCap, flexRoiCap, otherIncomeCap));

  if (!chainMode) {
    const walletNeed = roundXit(amountFromOtherIncome + amountFromFlexRoi);
    if (walletNeed > xitBalance + 1e-8) {
      throw new Error('Insufficient XIT balance for income portion of sell');
    }
  }

  const adminRate = parseFloat(await getSetting(conn, 'admin_charge_percent', '10'));
  const adminCharge = (tokenAmount * adminRate) / 100;
  const netXit = tokenAmount - adminCharge;
  const tokenPrice = parseFloat(await getSetting(conn, 'token_price', '1'));
  const usdtPayout = netXit * tokenPrice;

  return {
    user,
    config,
    chainMode,
    totalSellable,
    amountFromOtherIncome,
    amountFromFlexRoi,
    amountFromXitBalance,
    amountFromInvestments,
    targetInvestmentId,
    flexRoiInvestmentId:
      targetInvestmentId && amountFromFlexRoi > 0 ? targetInvestmentId : null,
    flexibleRoi,
    planSellable: sellableFromInvestments,
    otherIncomeCap,
    adminCharge,
    netXit,
    usdtPayout,
    paymentSymbol: chainMode ? config.paymentTokenSymbol : 'USDT',
  };
}

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

/**
 * Full pre-flight before user signs any on-chain XIT transfer.
 * Throws if sell cannot complete safely.
 */
export async function runSellPreflight(conn, userId, tokenAmount, investmentId = null) {
  const eligibility = await evaluateSellEligibility(conn, userId, tokenAmount, investmentId);

  if (!eligibility.chainMode) {
    return {
      ok: true,
      mode: 'demo',
      ...eligibility,
    };
  }

  if (!eligibility.config.bep20ContractAddress) {
    throw new Error('XIT contract not configured. Contact admin.');
  }

  const adminWallet = eligibility.config.adminPayoutWallet || eligibility.config.adminTreasuryWallet;
  if (!adminWallet) {
    throw new Error('Admin payout wallet not configured. Contact admin.');
  }

  await validateUserSellGas(conn, eligibility.user.wallet_address);
  await validateAdminSellPayout(conn, eligibility.usdtPayout);

  return {
    ok: true,
    mode: eligibility.config.platformMode,
    adminWallet,
    usdtPayout: eligibility.usdtPayout,
    paymentSymbol: eligibility.paymentSymbol,
    adminCharge: eligibility.adminCharge,
    netXit: eligibility.netXit,
    minUserBnb: MIN_USER_BNB_GAS,
  };
}
