import { pool } from '../db.js';
import { confirmPayoutTransaction, sendPaymentPayout } from './blockchainService.js';
import {
  deductFlexibleRoiReceived,
  deductInvestmentSellable,
  recordSellIncomeAllocation,
} from './sellBalanceService.js';

function roundXit(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

const OPEN_STATUSES = ['xit_received', 'payout_failed', 'payout_submitted'];

let tableReady = false;

export async function ensureSellOrdersTable(conn = pool) {
  if (tableReady) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS sell_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      investment_id INT DEFAULT NULL,
      token_amount DECIMAL(20,8) NOT NULL,
      admin_charge DECIMAL(20,8) NOT NULL,
      net_xit DECIMAL(20,8) NOT NULL,
      usdt_payout DECIMAL(20,8) NOT NULL,
      payment_symbol VARCHAR(16) NOT NULL DEFAULT 'USDT',
      amount_from_xit_balance DECIMAL(20,8) NOT NULL DEFAULT 0,
      amount_from_investments DECIMAL(20,8) NOT NULL DEFAULT 0,
      xit_tx_hash VARCHAR(66) NOT NULL,
      payout_tx_hash VARCHAR(66) DEFAULT NULL,
      chain_id INT DEFAULT NULL,
      status ENUM('xit_received','payout_failed','payout_submitted','completed') NOT NULL DEFAULT 'xit_received',
      error_message TEXT,
      transaction_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sell_orders_xit_tx (xit_tx_hash),
      INDEX idx_sell_orders_status (status),
      INDEX idx_sell_orders_user (user_id)
    )
  `);
  tableReady = true;
}

export async function findSellOrderByXitHash(conn, txHash) {
  await ensureSellOrdersTable(conn);
  const [rows] = await conn.query('SELECT * FROM sell_orders WHERE xit_tx_hash = ?', [txHash]);
  return rows[0] || null;
}

/** Latest open sell for member; prefers amount match, else most recent open order. */
export async function findOpenSellOrderForUser(conn, userId, tokenAmount) {
  await ensureSellOrdersTable(conn);
  const uid = Number(userId);
  const amt = Number(tokenAmount);
  const [exact] = await conn.query(
    `SELECT * FROM sell_orders
     WHERE user_id = ? AND status IN (?, ?, ?)
       AND ABS(token_amount - ?) < 0.0001
     ORDER BY id DESC LIMIT 1`,
    [uid, ...OPEN_STATUSES, amt]
  );
  if (exact.length > 0) return exact[0];

  const [latest] = await conn.query(
    `SELECT * FROM sell_orders
     WHERE user_id = ? AND status IN (?, ?, ?)
     ORDER BY id DESC LIMIT 1`,
    [uid, ...OPEN_STATUSES]
  );
  return latest[0] || null;
}

export async function applySellLedger(conn, {
  userId,
  amountFromXitBalance,
  amountFromOtherIncome,
  amountFromFlexRoi,
  amountFromInvestments,
  targetInvestmentId,
  chainMode,
  flexRoiInvestmentId = null,
}) {
  const walletTotal =
    amountFromOtherIncome != null || amountFromFlexRoi != null
      ? roundXit((Number(amountFromOtherIncome) || 0) + (Number(amountFromFlexRoi) || 0))
      : roundXit(Number(amountFromXitBalance) || 0);
  const flexRoiSlice =
    amountFromFlexRoi != null ? roundXit(Number(amountFromFlexRoi) || 0) : walletTotal;

  if (!chainMode && walletTotal > 0) {
    await conn.query('UPDATE users SET xit_balance = xit_balance - ? WHERE id = ?', [walletTotal, userId]);
  }

  if (flexRoiSlice > 0) {
    await deductFlexibleRoiReceived(conn, userId, flexRoiSlice, flexRoiInvestmentId);
  }

  if (amountFromInvestments > 0) {
    if (targetInvestmentId) {
      await deductInvestmentSellable(conn, targetInvestmentId, userId, amountFromInvestments);
    } else {
      let remainder = amountFromInvestments;

      while (remainder > 0) {
        const [invs] = await conn.query(
          `SELECT id, sellable_amount FROM investments
           WHERE user_id = ? AND sellable_amount > 0
             AND (status = 'active' OR (status = 'completed' AND plan_type IN ('lock', 'flexible_lock')))
           ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [userId]
        );

        if (invs.length === 0) break;

        const inv = invs[0];
        const available = Number(inv.sellable_amount);

        if (available >= remainder) {
          await deductInvestmentSellable(conn, inv.id, userId, remainder);
          remainder = 0;
        } else {
          await deductInvestmentSellable(conn, inv.id, userId, available);
          remainder -= available;
        }
      }
    }

    await conn.query(
      'UPDATE users SET total_invested = GREATEST(0, total_invested - ?) WHERE id = ?',
      [amountFromInvestments, userId]
    );
  }

  if (!chainMode) {
    return;
  }
}

function pendingDescription(order) {
  return `Sold ${Number(order.token_amount)} XIT — ${Number(order.usdt_payout).toFixed(8)} ${order.payment_symbol} payout pending (admin charge ${Number(order.admin_charge)} XIT). XIT received: ${order.xit_tx_hash}`;
}

function failedDescription(order, message) {
  return `Sold ${Number(order.token_amount)} XIT — ${order.payment_symbol} payout failed: ${message}. XIT received: ${order.xit_tx_hash}. Admin will retry.`;
}

function submittedDescription(order) {
  return `Sold ${Number(order.token_amount)} XIT — ${order.payment_symbol} payout sent, waiting confirmation. XIT: ${order.xit_tx_hash}. Payout: ${order.payout_tx_hash}`;
}

function completedDescription(order) {
  return `Sold ${Number(order.token_amount)} XIT → ${Number(order.usdt_payout).toFixed(8)} ${order.payment_symbol} (admin charge ${Number(order.admin_charge)} XIT). XIT return: ${order.xit_tx_hash}`;
}

export async function persistXitReceivedSell(conn, payload) {
  await applySellLedger(conn, {
    userId: payload.userId,
    amountFromXitBalance: payload.amountFromXitBalance,
    amountFromOtherIncome: payload.amountFromOtherIncome,
    amountFromFlexRoi: payload.amountFromFlexRoi,
    amountFromInvestments: payload.amountFromInvestments,
    targetInvestmentId: payload.targetInvestmentId,
    flexRoiInvestmentId: payload.flexRoiInvestmentId ?? null,
    chainMode: true,
  });

  const order = {
    userId: payload.userId,
    token_amount: payload.tokenAmount,
    admin_charge: payload.adminCharge,
    usdt_payout: payload.usdtPayout,
    payment_symbol: payload.paymentSymbol || 'USDT',
    xit_tx_hash: payload.xitTxHash,
  };

  const [txRes] = await conn.query(
    'INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, on_chain_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      payload.userId,
      'sell',
      payload.usdtPayout,
      pendingDescription(order),
      payload.xitTxHash,
      payload.chainId,
      'pending',
    ]
  );

  const [orderRes] = await conn.query(
    `INSERT INTO sell_orders (
      user_id, investment_id, token_amount, admin_charge, net_xit, usdt_payout, payment_symbol,
      amount_from_xit_balance, amount_from_investments, xit_tx_hash, chain_id, status, transaction_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'xit_received', ?)`,
    [
      payload.userId,
      payload.targetInvestmentId,
      payload.tokenAmount,
      payload.adminCharge,
      payload.netXit,
      payload.usdtPayout,
      payload.paymentSymbol || 'USDT',
      payload.amountFromXitBalance,
      payload.amountFromInvestments,
      payload.xitTxHash,
      payload.chainId,
      txRes.insertId,
    ]
  );

  await recordSellIncomeAllocation(conn, {
    userId: payload.userId,
    sellOrderId: orderRes.insertId,
    transactionId: txRes.insertId,
    fromReferral: payload.amountFromReferral,
    fromLevel: payload.amountFromLevel,
    fromReward: payload.amountFromReward,
    fromFlexibleRoi: payload.amountFromFlexRoi,
    fromFlexiblePrincipal: payload.amountFromInvestments,
  });

  return { sellOrderId: orderRes.insertId, transactionId: txRes.insertId };
}

export async function completeSellPayout(conn, order, payout) {
  const updated = {
    ...order,
    payout_tx_hash: payout.txHash,
  };

  await conn.query(
    `UPDATE sell_orders
     SET status = 'completed', payout_tx_hash = ?, error_message = NULL, chain_id = COALESCE(?, chain_id)
     WHERE id = ?`,
    [payout.txHash, payout.chainId || null, order.id]
  );

  if (order.transaction_id) {
    await conn.query(
      'UPDATE transactions SET on_chain_status = ?, description = ? WHERE id = ?',
      ['confirmed', completedDescription(updated), order.transaction_id]
    );
  }
}

export async function markSellPayoutFailed(conn, order, message, extra = {}) {
  const status = extra.payoutSubmitted ? 'payout_submitted' : 'payout_failed';
  const payoutHash = extra.txHash || order.payout_tx_hash || null;
  const updated = { ...order, payout_tx_hash: payoutHash, payment_symbol: order.payment_symbol };
  const description = extra.payoutSubmitted
    ? submittedDescription(updated)
    : failedDescription(updated, message);

  await conn.query(
    'UPDATE sell_orders SET status = ?, payout_tx_hash = ?, error_message = ? WHERE id = ?',
    [status, payoutHash, String(message || 'Payout failed').slice(0, 2000), order.id]
  );

  if (order.transaction_id) {
    await conn.query(
      'UPDATE transactions SET on_chain_status = ?, description = ? WHERE id = ?',
      [extra.payoutSubmitted ? 'pending' : 'failed', description, order.transaction_id]
    );
  }
}

export async function attemptSellPayout(order) {
  const conn = await pool.getConnection();
  try {
    await ensureSellOrdersTable(conn);
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM sell_orders WHERE id = ? FOR UPDATE', [order.id]);
    const locked = rows[0];
    if (!locked) {
      await conn.rollback();
      return { ok: false, error: 'Sell order not found' };
    }

    if (locked.status === 'completed') {
      await conn.commit();
      return { ok: true, already: true, txHash: locked.payout_tx_hash };
    }

    if (locked.status === 'payout_submitted' && locked.payout_tx_hash) {
      const check = await confirmPayoutTransaction(conn, locked.payout_tx_hash);
      if (check.confirmed) {
        await completeSellPayout(conn, locked, { txHash: locked.payout_tx_hash, chainId: check.chainId });
        await conn.commit();
        return { ok: true, confirmed: true, txHash: locked.payout_tx_hash };
      }
      if (check.failed) {
        await markSellPayoutFailed(conn, locked, 'Payout transaction failed on-chain');
        await conn.commit();
        return { ok: false, error: 'Payout transaction failed on-chain' };
      }
      await conn.commit();
      return { ok: false, waiting: true, error: 'Payout sent, waiting for confirmation' };
    }

    const [users] = await conn.query('SELECT wallet_address FROM users WHERE id = ?', [locked.user_id]);
    const wallet = users[0]?.wallet_address;
    if (!wallet) {
      await markSellPayoutFailed(conn, locked, 'User wallet not linked');
      await conn.commit();
      return { ok: false, error: 'User wallet not linked' };
    }

    try {
      const payout = await sendPaymentPayout(conn, wallet, Number(locked.usdt_payout));
      await completeSellPayout(conn, locked, payout);
      await conn.commit();
      return { ok: true, txHash: payout.txHash };
    } catch (err) {
      await markSellPayoutFailed(conn, locked, err.message, {
        payoutSubmitted: !!err.payoutSubmitted,
        txHash: err.txHash,
      });
      await conn.commit();
      return {
        ok: false,
        error: err.message,
        payoutSubmitted: !!err.payoutSubmitted,
        txHash: err.txHash || null,
      };
    }
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function retryOpenSellPayouts({ sellOrderId } = {}) {
  await ensureSellOrdersTable();
  let sql = `SELECT * FROM sell_orders WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
  const params = [...OPEN_STATUSES];
  if (sellOrderId) {
    sql += ' AND id = ?';
    params.push(sellOrderId);
  }
  sql += ' ORDER BY id ASC LIMIT 50';

  const [rows] = await pool.query(sql, params);
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: row.id, userId: row.user_id, ...(await attemptSellPayout(row)) });
    } catch (err) {
      results.push({ id: row.id, userId: row.user_id, ok: false, error: err.message });
    }
  }

  return {
    attempted: results.length,
    completed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

export async function listOpenSellOrders() {
  await ensureSellOrdersTable();
  const [rows] = await pool.query(
    `SELECT so.*, u.username, u.email, u.wallet_address
     FROM sell_orders so
     JOIN users u ON u.id = so.user_id
     WHERE so.status IN (?, ?, ?)
     ORDER BY so.id DESC
     LIMIT 200`,
    OPEN_STATUSES
  );
  return rows.map((row) => ({
    ...row,
    token_amount: Number(row.token_amount),
    admin_charge: Number(row.admin_charge),
    net_xit: Number(row.net_xit),
    usdt_payout: Number(row.usdt_payout),
    amount_from_xit_balance: Number(row.amount_from_xit_balance),
    amount_from_investments: Number(row.amount_from_investments),
  }));
}

export function buildSellResponse(order, result, config) {
  const explorer = config?.blockExplorerUrl || '';
  const sold = Number(order.token_amount);
  const adminCharge = Number(order.admin_charge);
  const usdtPayout = Number(order.usdt_payout);
  const paymentSymbol = order.payment_symbol || config?.paymentTokenSymbol || 'USDT';
  const tokenReturnTxHash = order.xit_tx_hash;
  const payoutTxHash = result.txHash || order.payout_tx_hash || null;

  if (result.ok) {
    return {
      success: true,
      payoutPending: false,
      sold,
      investmentId: order.investment_id,
      adminCharge,
      net: Number(order.net_xit),
      usdtReceived: usdtPayout,
      paymentSymbol,
      txHash: payoutTxHash,
      tokenReturnTxHash,
      mode: config?.platformMode || 'real',
      explorerUrl: payoutTxHash && explorer ? `${explorer}/tx/${payoutTxHash}` : null,
      tokenReturnExplorerUrl: tokenReturnTxHash && explorer ? `${explorer}/tx/${tokenReturnTxHash}` : null,
    };
  }

  return {
    success: true,
    payoutPending: true,
    sold,
    investmentId: order.investment_id,
    adminCharge,
    net: Number(order.net_xit),
    usdtReceived: 0,
    expectedUsdt: usdtPayout,
    paymentSymbol,
    txHash: payoutTxHash,
    tokenReturnTxHash,
    mode: config?.platformMode || 'real',
    explorerUrl: payoutTxHash && explorer ? `${explorer}/tx/${payoutTxHash}` : null,
    tokenReturnExplorerUrl: tokenReturnTxHash && explorer ? `${explorer}/tx/${tokenReturnTxHash}` : null,
    message: result.waiting
      ? `XIT received. ${paymentSymbol} payout was sent and is waiting for confirmation.`
      : `XIT received (${sold} tokens). ${paymentSymbol} payout is pending and will be retried automatically. ${result.error || ''}`.trim(),
  };
}
