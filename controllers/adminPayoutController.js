import { pool } from '../db.js';
import { previewPayout, runPayout } from '../services/payoutService.js';

export async function getPayoutPreview(req, res) {
  try {
    const preview = await previewPayout();
    res.json({ success: true, ...preview });
  } catch (err) {
    console.error('Payout preview error:', err);
    res.status(500).json({ error: 'Failed to generate payout preview' });
  }
}

export async function triggerPayout(req, res) {
  try {
    const preview = await previewPayout();
    if (preview.eligibleInvestments === 0) {
      return res.status(400).json({ error: 'No eligible investments for payout today' });
    }

    const result = await runPayout({
      runType: 'manual',
      triggeredBy: req.adminEmail || 'admin',
    });

    res.json({ success: true, ...result, preview });
  } catch (err) {
    console.error('Manual payout error:', err);
    res.status(500).json({ error: 'Payout failed' });
  }
}

export async function getPayoutRuns(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(50, Math.max(10, parseInt(req.query.limit || '20')));
    const offset = (page - 1) * limit;

    const [countRows] = await pool.query('SELECT COUNT(*) as total FROM payout_runs');
    const total = Number(countRows[0].total);

    const [runs] = await pool.query(
      `SELECT * FROM payout_runs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json({
      success: true,
      items: runs.map((r) => ({
        id: r.id,
        run_type: r.run_type,
        run_date: r.run_date,
        investments_processed: Number(r.investments_processed),
        total_roi: Number(r.total_roi),
        total_level_bonus: Number(r.total_level_bonus),
        total_reward_bonus: Number(r.total_reward_bonus),
        total_payout: Number(r.total_payout),
        status: r.status,
        triggered_by: r.triggered_by,
        created_at: r.created_at,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }
    console.error('Payout runs error:', err);
    res.status(500).json({ error: 'Failed to load payout history' });
  }
}

export async function getDailyPayoutSummary(req, res) {
  try {
    const { date_from, date_to } = req.query;
    let where = "WHERE type IN ('roi', 'level_bonus', 'reward_bonus')";
    const params = [];

    if (date_from) {
      where += ' AND DATE(created_at) >= ?';
      params.push(date_from);
    }
    if (date_to) {
      where += ' AND DATE(created_at) <= ?';
      params.push(date_to);
    }

    const [dailyRows] = await pool.query(
      `SELECT DATE(created_at) as payout_date,
              SUM(CASE WHEN type = 'roi' THEN amount ELSE 0 END) as roi,
              SUM(CASE WHEN type = 'level_bonus' THEN amount ELSE 0 END) as level_bonus,
              SUM(CASE WHEN type = 'reward_bonus' THEN amount ELSE 0 END) as reward_bonus,
              SUM(amount) as total,
              COUNT(*) as tx_count
       FROM transactions
       ${where}
       GROUP BY DATE(created_at)
       ORDER BY payout_date DESC
       LIMIT 90`,
      params
    );

    const [totals] = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'roi' THEN amount ELSE 0 END), 0) as total_roi,
        COALESCE(SUM(CASE WHEN type = 'level_bonus' THEN amount ELSE 0 END), 0) as total_level,
        COALESCE(SUM(CASE WHEN type = 'reward_bonus' THEN amount ELSE 0 END), 0) as total_reward,
        COALESCE(SUM(amount), 0) as grand_total
       FROM transactions ${where}`,
      params
    );

    res.json({
      success: true,
      summary: {
        total_roi: Number(totals[0].total_roi),
        total_level_bonus: Number(totals[0].total_level),
        total_reward_bonus: Number(totals[0].total_reward),
        grand_total: Number(totals[0].grand_total),
      },
      daily: dailyRows.map((d) => ({
        date: d.payout_date,
        roi: Number(d.roi),
        level_bonus: Number(d.level_bonus),
        reward_bonus: Number(d.reward_bonus),
        total: Number(d.total),
        tx_count: Number(d.tx_count),
      })),
    });
  } catch (err) {
    console.error('Daily payout summary error:', err);
    res.status(500).json({ error: 'Failed to load daily payout summary' });
  }
}

export async function getTradeHistory(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '25')));
    const offset = (page - 1) * limit;
    const { type = 'all', date_from, date_to, search = '' } = req.query;

    let where = "WHERE t.type IN ('buy', 'sell')";
    const params = [];

    if (type === 'buy' || type === 'sell') {
      where = 'WHERE t.type = ?';
      params.push(type);
    }

    if (date_from) {
      where += ' AND DATE(t.created_at) >= ?';
      params.push(date_from);
    }
    if (date_to) {
      where += ' AND DATE(t.created_at) <= ?';
      params.push(date_to);
    }
    if (search) {
      where += ' AND (u.username LIKE ? OR u.email LIKE ? OR t.description LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM transactions t JOIN users u ON u.id = t.user_id ${where}`,
      params
    );
    const total = Number(countRows[0].total);

    const [items] = await pool.query(
      `SELECT t.id, t.user_id, u.username, u.email, t.type, t.amount, t.description,
              t.on_chain_status, t.tx_hash, t.created_at
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      items: items.map((t) => ({
        id: t.id,
        user_id: t.user_id,
        username: t.username,
        email: t.email,
        type: t.type,
        amount: Number(t.amount),
        description: t.description,
        on_chain_status: t.on_chain_status,
        tx_hash: t.tx_hash,
        created_at: t.created_at,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('Trade history error:', err);
    res.status(500).json({ error: 'Failed to load trade history' });
  }
}

export async function getDailyTradeSummary(req, res) {
  try {
    const { date_from, date_to } = req.query;
    let where = "WHERE type IN ('buy', 'sell')";
    const params = [];

    if (date_from) {
      where += ' AND DATE(created_at) >= ?';
      params.push(date_from);
    }
    if (date_to) {
      where += ' AND DATE(created_at) <= ?';
      params.push(date_to);
    }

    const [dailyRows] = await pool.query(
      `SELECT DATE(created_at) as trade_date,
              SUM(CASE WHEN type = 'buy' THEN amount ELSE 0 END) as buy_total,
              SUM(CASE WHEN type = 'sell' THEN amount ELSE 0 END) as sell_total,
              SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END) as buy_count,
              SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END) as sell_count
       FROM transactions
       ${where}
       GROUP BY DATE(created_at)
       ORDER BY trade_date DESC
       LIMIT 90`,
      params
    );

    const [totals] = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'buy' THEN amount ELSE 0 END), 0) as total_buy,
        COALESCE(SUM(CASE WHEN type = 'sell' THEN amount ELSE 0 END), 0) as total_sell,
        COALESCE(SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END), 0) as buy_count,
        COALESCE(SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END), 0) as sell_count
       FROM transactions ${where}`,
      params
    );

    res.json({
      success: true,
      summary: {
        total_buy: Number(totals[0].total_buy),
        total_sell: Number(totals[0].total_sell),
        buy_count: Number(totals[0].buy_count),
        sell_count: Number(totals[0].sell_count),
        net: Number(totals[0].total_buy) - Number(totals[0].total_sell),
      },
      daily: dailyRows.map((d) => ({
        date: d.trade_date,
        buy_total: Number(d.buy_total),
        sell_total: Number(d.sell_total),
        buy_count: Number(d.buy_count),
        sell_count: Number(d.sell_count),
        net: Number(d.buy_total) - Number(d.sell_total),
      })),
    });
  } catch (err) {
    console.error('Daily trade summary error:', err);
    res.status(500).json({ error: 'Failed to load trade summary' });
  }
}
