import { pool } from '../db.js';
import { getBlockchainConfig, isBlockchainMode } from './blockchainService.js';
import { calculateInvestmentRoi } from './payoutService.js';
import { getISTDateString } from '../utils/istDate.js';

function maskAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const a = addr.trim();
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Full payout/ROI environment diagnostic — safe to expose to admin (wallets masked).
 */
export async function buildPayoutDebugReport({ asOfDate = null } = {}) {
  const conn = await pool.getConnection();
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    istDate: getISTDateString(),
    asOfDate: asOfDate || getISTDateString(),
    env: {},
    database: {},
    platform: {},
    payoutRunsToday: [],
    summary: {},
    investments: [],
    failuresPredicted: [],
    notes: [],
  };

  try {
    report.env = {
      DB_HOST: process.env.DB_HOST || '(default localhost)',
      DB_PORT: process.env.DB_PORT || '(default 3306)',
      DB_NAME: process.env.DB_NAME || '(MISSING — code falls back to xit_token)',
      DB_USER: process.env.DB_USER || '(MISSING)',
      DB_PASSWORD_SET: Boolean(process.env.DB_PASSWORD),
      ADMIN_PRIVATE_KEY_SET: Boolean(process.env.ADMIN_PRIVATE_KEY),
      ADMIN_PRIVATE_KEY_LEN: process.env.ADMIN_PRIVATE_KEY
        ? String(process.env.ADMIN_PRIVATE_KEY).replace(/^0x/i, '').length
        : 0,
      CRON_SECRET_SET: Boolean(process.env.CRON_SECRET),
      CRON_SECRET_LEN: process.env.CRON_SECRET ? String(process.env.CRON_SECRET).length : 0,
      AUTO_ROI_CRON: process.env.AUTO_ROI_CRON ?? '(not set)',
      JWT_SECRET_SET: Boolean(process.env.JWT_SECRET),
      NODE_ENV: process.env.NODE_ENV || '(not set)',
    };

    if (!process.env.DB_NAME) {
      report.notes.push(
        'CRITICAL: DB_NAME env is missing. db.js defaults to database "xit_token" — may not be xittoken_db.'
      );
      report.ok = false;
    }

    const [dbRows] = await conn.query(
      'SELECT DATABASE() AS current_db, USER() AS db_user, @@hostname AS hostname, @@version AS mysql_version'
    );
    report.database = {
      current_db: dbRows[0]?.current_db,
      db_user: dbRows[0]?.db_user,
      hostname: dbRows[0]?.hostname,
      mysql_version: dbRows[0]?.mysql_version,
      env_DB_NAME_matches:
        !process.env.DB_NAME || process.env.DB_NAME === dbRows[0]?.current_db,
    };

    if (process.env.DB_NAME && process.env.DB_NAME !== dbRows[0]?.current_db) {
      report.notes.push(
        `CRITICAL: ENV DB_NAME=${process.env.DB_NAME} but connection is on ${dbRows[0]?.current_db}`
      );
      report.ok = false;
    }

    const config = await getBlockchainConfig(conn);
    const chainMode = isBlockchainMode(config.platformMode);
    report.platform = {
      platformMode: config.platformMode,
      chainMode,
      chainId: config.chainId,
      chainName: config.chainName,
      bep20ContractAddress: config.bep20ContractAddress || '(empty)',
      rpcUrlSet: Boolean(config.rpcUrl),
      adminTreasuryWallet: maskAddress(config.adminTreasuryWallet),
      adminPayoutWallet: maskAddress(config.adminPayoutWallet),
      tokenDecimals: config.tokenDecimals,
    };

    if (chainMode && !process.env.ADMIN_PRIVATE_KEY) {
      report.notes.push('CRITICAL: ADMIN_PRIVATE_KEY missing — on-chain ROI transfers will fail.');
      report.ok = false;
    }
    if (chainMode && !config.bep20ContractAddress) {
      report.notes.push('CRITICAL: bep20_contract_address not set in settings.');
      report.ok = false;
    }
    if (chainMode && !config.rpcUrl) {
      report.notes.push('CRITICAL: rpc_url not set in settings.');
      report.ok = false;
    }

    const runDate = asOfDate || getISTDateString();
    const [runs] = await conn.query(
      `SELECT id, run_type, run_date, investments_processed, total_roi, total_payout, triggered_by, created_at
       FROM payout_runs WHERE run_date = ? ORDER BY id DESC LIMIT 10`,
      [runDate]
    );
    report.payoutRunsToday = runs.map((r) => ({
      id: r.id,
      run_type: r.run_type,
      run_date: r.run_date,
      investments_processed: Number(r.investments_processed),
      total_roi: Number(r.total_roi),
      total_payout: Number(r.total_payout),
      triggered_by: r.triggered_by,
      created_at: r.created_at,
    }));

    const autoZero = runs.find(
      (r) => r.run_type === 'auto' && Number(r.investments_processed) === 0
    );
    if (autoZero) {
      report.notes.push(
        `WARNING: auto payout_runs id=${autoZero.id} for ${runDate} already exists with 0 processed — next cron will SKIP unless that row is deleted.`
      );
    }

    const [investments] = await conn.query(
      `SELECT i.id, i.user_id, u.username, u.email, u.wallet_address,
              i.plan_type, i.token_amount, i.daily_roi_rate, i.roi_received,
              i.total_return, i.last_roi_date, i.status, i.created_at
       FROM investments i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active'
       ORDER BY i.id`
    );

    let eligible = 0;
    let withWallet = 0;
    let withoutWallet = 0;
    let predictedRoi = 0;
    let wouldFailWallet = 0;
    let wouldPay = 0;

    for (const inv of investments) {
      const walletRaw = inv.wallet_address;
      const wallet = typeof walletRaw === 'string' ? walletRaw.trim() : walletRaw;
      const hasWallet = Boolean(wallet);
      const calc = calculateInvestmentRoi(inv, report.asOfDate);

      const row = {
        investmentId: inv.id,
        userId: inv.user_id,
        username: inv.username,
        plan: inv.plan_type,
        tokenAmount: Number(inv.token_amount),
        dailyRoiRate: Number(inv.daily_roi_rate),
        lastRoiDate: inv.last_roi_date,
        lastRoiNormalized: inv.last_roi_date
          ? new Date(inv.last_roi_date).toISOString().split('T')[0]
          : null,
        roiReceived: Number(inv.roi_received),
        totalReturn: Number(inv.total_return),
        hasWallet,
        walletMasked: maskAddress(wallet),
        walletLen: wallet ? String(wallet).length : 0,
        userIdType: typeof inv.user_id,
        calcDays: calc?.days ?? null,
        calcRoi: calc?.roi ?? null,
        eligible: Boolean(calc && calc.roi > 0),
        willFailOnChain: false,
        predictedAction: 'skip_not_due',
      };

      if (row.eligible) {
        eligible++;
        predictedRoi += calc.roi;
        if (chainMode && !hasWallet) {
          withoutWallet++;
          wouldFailWallet++;
          row.willFailOnChain = true;
          row.predictedAction = 'FAIL_no_wallet';
          report.failuresPredicted.push({
            investmentId: inv.id,
            userId: inv.user_id,
            username: inv.username,
            reason: 'Link your MetaMask wallet to receive on-chain XIT income',
            walletInDb: hasWallet,
            walletLen: row.walletLen,
          });
        } else if (chainMode && hasWallet) {
          withWallet++;
          wouldPay++;
          row.predictedAction = 'PAY_onchain';
        } else {
          wouldPay++;
          row.predictedAction = 'PAY_demo_balance';
        }
      } else if (!hasWallet && chainMode) {
        withoutWallet++;
      } else if (hasWallet) {
        withWallet++;
      }

      report.investments.push(row);
    }

    report.summary = {
      activeInvestments: investments.length,
      eligibleForRoiToday: eligible,
      predictedTotalRoi: Number(predictedRoi.toFixed(8)),
      wouldPayOnSuccess: wouldPay,
      wouldFailMissingWallet: wouldFailWallet,
      usersWithWalletAmongActive: withWallet,
      usersWithoutWalletAmongActive: withoutWallet,
      chainMode,
    };

    if (wouldFailWallet > 0 && wouldPay === 0 && eligible > 0) {
      report.notes.push(
        'All eligible investments would FAIL for missing wallet — matches cron investmentsProcessed:0.'
      );
      report.ok = false;
    }

    if (wouldFailWallet > 0 && wouldPay > 0) {
      report.notes.push(
        `${wouldPay} investments should PAY; ${wouldFailWallet} will FAIL (no wallet). If cron still fails the PAY ones, Node may be on a different DB or code is stale.`
      );
    }

    // Direct spot-check of known wallet users (ids from production dump)
    const [spot] = await conn.query(
      `SELECT id, username,
              wallet_address,
              CASE WHEN wallet_address IS NULL OR TRIM(wallet_address) = '' THEN 0 ELSE 1 END AS has_wallet,
              CHAR_LENGTH(IFNULL(wallet_address,'')) AS wallet_len
       FROM users WHERE id IN (50, 51, 52) ORDER BY id`
    );
    report.spotCheckUsers50to52 = spot.map((u) => ({
      id: u.id,
      username: u.username,
      has_wallet: Boolean(u.has_wallet),
      wallet_len: Number(u.wallet_len),
      walletMasked: maskAddress(u.wallet_address),
    }));

    const spotMissing = report.spotCheckUsers50to52.filter((u) => !u.has_wallet);
    if (spotMissing.length && chainMode) {
      report.notes.push(
        `Spot-check: user ids ${spotMissing.map((u) => u.id).join(',')} have EMPTY wallet in THIS connection's DB.`
      );
    }

    return report;
  } finally {
    conn.release();
  }
}
