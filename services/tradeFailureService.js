import { pool } from '../db.js';

/**
 * Record failed buy (USDT paid or verified, XIT/plan not completed). Allows retry via verifyBuyTransaction rule.
 */
export async function recordFailedBuy(conn, {
  userId,
  tokenAmount,
  planType,
  txHash,
  chainId,
  paymentSymbol,
  reason,
}) {
  const hash = String(txHash).trim();
  const [existing] = await conn.query(
    'SELECT id, type, on_chain_status FROM transactions WHERE tx_hash = ? LIMIT 1',
    [hash]
  );
  if (existing.length > 0) {
    const row = existing[0];
    if (row.type === 'buy' && row.on_chain_status === 'failed') {
      await conn.query(
        'UPDATE transactions SET amount = ?, description = ?, chain_id = ?, on_chain_status = ? WHERE id = ?',
        [
          tokenAmount,
          buildFailedBuyDescription(planType, paymentSymbol, reason),
          chainId,
          'failed',
          row.id,
        ]
      );
      return row.id;
    }
    return null;
  }

  const [res] = await conn.query(
    `INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, on_chain_status)
     VALUES (?, 'buy', ?, ?, ?, ?, 'failed')`,
    [
      userId,
      tokenAmount,
      buildFailedBuyDescription(planType, paymentSymbol, reason),
      hash,
      chainId || null,
    ]
  );
  return res.insertId;
}

function buildFailedBuyDescription(planType, paymentSymbol, reason) {
  const plan = planType ? `${planType} plan` : 'plan';
  const sym = paymentSymbol || 'USDT';
  return `Buy failed — ${plan} (${sym} received on-chain). ${String(reason || 'Unknown error').slice(0, 500)}`;
}

export async function recordFailedBuyStandalone(params) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = await recordFailedBuy(conn, params);
    await conn.commit();
    return id;
  } catch (err) {
    await conn.rollback();
    console.error('recordFailedBuyStandalone:', err.message);
    return null;
  } finally {
    conn.release();
  }
}

export async function upgradeFailedBuyToSuccess(conn, txHash, update) {
  const hash = String(txHash).trim();
  await conn.query(
    `UPDATE transactions SET description = ?, investment_id = ?, on_chain_status = 'confirmed', chain_id = COALESCE(?, chain_id)
     WHERE tx_hash = ? AND type = 'buy' AND on_chain_status = 'failed'`,
    [update.description, update.investmentId, update.chainId, hash]
  );
}

function buildFailedSellDescription(tokenAmount, reason, xitVerified) {
  const base = xitVerified
    ? `Sell failed — ${tokenAmount} XIT received on-chain; plan/payout not completed.`
    : `Sell failed — ${tokenAmount} XIT requested.`;
  return `${base} ${String(reason || 'Unknown error').slice(0, 500)}`;
}

/**
 * Record failed sell attempt (verify, eligibility, or persist). Allows retry when status is failed/pending.
 */
export async function recordFailedSell(conn, {
  userId,
  tokenAmount,
  txHash,
  chainId,
  usdtAmount,
  reason,
  xitVerifiedOnChain,
}) {
  const hash = txHash ? String(txHash).trim() : null;
  if (!hash) return null;

  const [existing] = await conn.query(
    'SELECT id, type, on_chain_status FROM transactions WHERE tx_hash = ? LIMIT 1',
    [hash]
  );
  const description = buildFailedSellDescription(tokenAmount, reason, xitVerifiedOnChain);
  const amount = usdtAmount != null ? Number(usdtAmount) : 0;

  if (existing.length > 0) {
    const row = existing[0];
    if (row.type === 'sell' && (row.on_chain_status === 'failed' || row.on_chain_status === 'pending')) {
      await conn.query(
        'UPDATE transactions SET user_id = ?, amount = ?, description = ?, chain_id = COALESCE(?, chain_id), on_chain_status = ? WHERE id = ?',
        [userId, amount, description, chainId, 'failed', row.id]
      );
      return row.id;
    }
    return null;
  }

  const [res] = await conn.query(
    `INSERT INTO transactions (user_id, type, amount, description, tx_hash, chain_id, on_chain_status)
     VALUES (?, 'sell', ?, ?, ?, ?, 'failed')`,
    [userId, amount, description, hash, chainId || null]
  );
  return res.insertId;
}

export async function recordFailedSellStandalone(params) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = await recordFailedSell(conn, params);
    await conn.commit();
    return id;
  } catch (err) {
    await conn.rollback();
    console.error('recordFailedSellStandalone:', err.message);
    return null;
  } finally {
    conn.release();
  }
}
