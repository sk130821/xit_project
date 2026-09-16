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
  allocateSellAmount,
  computeMemberFlexAwareSellable,
  getInvestmentBalanceStats,
  investmentAllowsSell,
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

  const xitBalance = Number(user.xit_balance || 0);
  const balanceStats = await getInvestmentBalanceStats(conn, userId);
  const {
    planSellable: sellableFromInvestments,
    planLocked,
    lockRoiHeld,
    flexibleRoi,
  } = balanceStats;
  const sellableView = computeMemberFlexAwareSellable(sellableFromInvestments, flexibleRoi);

  const config = await getBlockchainConfig(conn);
  const chainMode = isBlockchainMode(config.platformMode);

  let totalSellable;
  let amountFromXitBalance = 0;
  let amountFromInvestments = 0;
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
    const invTotalSellable = invSellable + invFlexRoi;
    if (invTotalSellable <= 0) {
      throw new Error('This investment has no sellable tokens');
    }
    if (tokenAmount > invTotalSellable) {
      throw new Error(`Maximum sellable from this investment is ${invTotalSellable} XIT`);
    }

    ({ amountFromInvestments, amountFromXitBalance } = allocateSellAmount(
      tokenAmount,
      invSellable,
      invFlexRoi
    ));
    totalSellable = invTotalSellable;

    if (chainMode) {
      if (!user.wallet_address) {
        throw new Error('Link your MetaMask wallet before selling in blockchain mode');
      }
      if (!postTransferVerified) {
        const onChainBalance = await getUserOnChainXitBalance(conn, user.wallet_address);
        if (tokenAmount > onChainBalance) {
          throw new Error('Insufficient XIT balance in your wallet');
        }
      }
    }
  } else if (chainMode) {
    if (!user.wallet_address) {
      throw new Error('Link your MetaMask wallet before selling in blockchain mode');
    }

    totalSellable = sellableView.totalSellable;

    if (tokenAmount > totalSellable) {
      throw new Error(`Maximum sellable from your plan is ${totalSellable} XIT`);
    }

    const onChainBalance = await getUserOnChainXitBalance(conn, user.wallet_address);
    if (!postTransferVerified && tokenAmount > onChainBalance) {
      throw new Error('Insufficient XIT balance in your wallet');
    }

    ({ amountFromInvestments, amountFromXitBalance } = allocateSellAmount(
      tokenAmount,
      sellableFromInvestments,
      flexibleRoi
    ));
  } else {
    totalSellable = sellableView.totalSellable;

    if (tokenAmount > totalSellable) {
      throw new Error('Insufficient sellable XIT tokens');
    }

    ({ amountFromInvestments, amountFromXitBalance } = allocateSellAmount(
      tokenAmount,
      sellableFromInvestments,
      flexibleRoi
    ));

    if (amountFromXitBalance > xitBalance) {
      throw new Error('Insufficient XIT balance for flexible ROI portion');
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
    amountFromXitBalance,
    amountFromInvestments,
    targetInvestmentId,
    flexRoiInvestmentId:
      targetInvestmentId && amountFromXitBalance > 0 ? targetInvestmentId : null,
    flexibleRoi,
    planSellable: sellableFromInvestments,
    adminCharge,
    netXit,
    usdtPayout,
    paymentSymbol: chainMode ? config.paymentTokenSymbol : 'USDT',
  };
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
