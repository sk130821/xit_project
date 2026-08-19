import { pool } from '../db.js';
import { getSetting } from '../services/incomeService.js';

export async function getBusinessReport(req, res) {
  try {
    const { date_from, date_to } = req.query;

    const conn = await pool.getConnection();
    try {
      const adminChargePercent = parseFloat(await getSetting(conn, 'admin_charge_percent', '10'));
      const tokenPrice = parseFloat(await getSetting(conn, 'token_price', '1'));

      let trendDays = 30;
      if (date_from && date_to) {
        trendDays = Math.min(90, Math.max(7, Math.ceil((new Date(date_to) - new Date(date_from)) / 86400000) + 1));
      }

      // ── Overview (always full platform totals) ──
      const [userStats] = await conn.query(
        `SELECT
          COUNT(*) as total_users,
          SUM(is_active = 1) as active_users,
          SUM(total_invested > 0) as invested_members,
          COALESCE(SUM(total_invested), 0) as total_invested,
          COALESCE(SUM(total_purchased), 0) as total_purchased,
          COALESCE(SUM(total_earned), 0) as total_earned,
          COALESCE(SUM(wallet_balance), 0) as total_wallet_usdt,
          COALESCE(SUM(xit_balance), 0) as total_xit_balance,
          SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) as new_today,
          SUM(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as new_week,
          SUM(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as new_month
         FROM users`
      );

      const [invStats] = await conn.query(
        `SELECT
          COUNT(*) as total_investments,
          SUM(status = 'active') as active_investments,
          SUM(status = 'completed') as completed_investments,
          SUM(plan_type = 'lock') as lock_count,
          SUM(plan_type = 'flexible') as flex_count,
          COALESCE(SUM(CASE WHEN plan_type = 'lock' THEN token_amount ELSE 0 END), 0) as lock_amount,
          COALESCE(SUM(CASE WHEN plan_type = 'flexible' THEN token_amount ELSE 0 END), 0) as flex_amount,
          COALESCE(SUM(token_amount), 0) as total_plan_tokens,
          COALESCE(SUM(roi_received), 0) as total_roi_received,
          COALESCE(SUM(sellable_amount), 0) as total_sellable,
          COALESCE(SUM(locked_amount), 0) as total_locked
         FROM investments`
      );

      // ── Transactions / Income ──
      let txWhere = 'WHERE 1=1';
      const txFilterParams = [];
      let txDateClause = '';
      if (date_from) {
        txWhere += ' AND DATE(created_at) >= ?';
        txDateClause += ' AND DATE(created_at) >= ?';
        txFilterParams.push(date_from);
      }
      if (date_to) {
        txWhere += ' AND DATE(created_at) <= ?';
        txDateClause += ' AND DATE(created_at) <= ?';
        txFilterParams.push(date_to);
      }
      const trendClause = date_from ? txDateClause : ` AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${trendDays} DAY)`;

      const [txStats] = await conn.query(
        `SELECT
          COALESCE(SUM(CASE WHEN type = 'buy' THEN amount ELSE 0 END), 0) as total_buy_xit,
          COALESCE(SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END), 0) as buy_count,
          COALESCE(SUM(CASE WHEN type = 'sell' THEN amount ELSE 0 END), 0) as total_sell_usdt,
          COALESCE(SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END), 0) as sell_count,
          COALESCE(SUM(CASE WHEN type = 'roi' THEN amount ELSE 0 END), 0) as roi_paid,
          COALESCE(SUM(CASE WHEN type = 'referral_bonus' THEN amount ELSE 0 END), 0) as referral_paid,
          COALESCE(SUM(CASE WHEN type = 'level_bonus' THEN amount ELSE 0 END), 0) as level_paid,
          COALESCE(SUM(CASE WHEN type = 'reward_bonus' THEN amount ELSE 0 END), 0) as reward_paid,
          COALESCE(SUM(CASE WHEN type IN ('roi','referral_bonus','level_bonus','reward_bonus') THEN amount ELSE 0 END), 0) as total_income_paid,
          COALESCE(SUM(CASE WHEN type = 'admin_credit' THEN amount ELSE 0 END), 0) as admin_credits,
          COALESCE(SUM(CASE WHEN type = 'admin_debit' THEN amount ELSE 0 END), 0) as admin_debits
         FROM transactions ${txWhere}`,
        txFilterParams
      );

      const estimatedBuyUsdt = Number(txStats[0].total_buy_xit) * tokenPrice;
      const estimatedAdminSellRevenue = Number(txStats[0].total_sell_usdt) * (adminChargePercent / (100 - adminChargePercent));

      // ── Network ──
      const [netStats] = await conn.query(
        `SELECT
          (SELECT COUNT(*) FROM referral_relations) as total_relations,
          (SELECT COUNT(DISTINCT upline_id) FROM referral_relations) as members_with_team,
          (SELECT COUNT(*) FROM users WHERE sponsor_id IS NOT NULL) as referred_users
         FROM DUAL`
      );

      const [avgTeam] = await conn.query(
        `SELECT COALESCE(AVG(team_size), 0) as avg_team FROM (
          SELECT u.id, (SELECT COUNT(*) FROM referral_relations rr WHERE rr.upline_id = u.id) as team_size
          FROM users u
        ) t`
      );

      // ── Daily trends ──
      const trendParams = [];
      let regFilter = `WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${trendDays} DAY)`;
      if (date_from) { regFilter = 'WHERE DATE(created_at) >= ?'; trendParams.push(date_from); if (date_to) { regFilter += ' AND DATE(created_at) <= ?'; trendParams.push(date_to); } }

      const [regDaily] = await conn.query(
        `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM users ${regFilter}
         GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`,
        trendParams
      );

      const [buyDaily] = await conn.query(
        `SELECT DATE(created_at) as date, SUM(amount) as buy_xit, COUNT(*) as count
         FROM transactions WHERE type = 'buy' ${trendClause}
         GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`,
        txFilterParams
      );

      const [sellDaily] = await conn.query(
        `SELECT DATE(created_at) as date, SUM(amount) as sell_usdt, COUNT(*) as count
         FROM transactions WHERE type = 'sell' ${trendClause}
         GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`,
        txFilterParams
      );

      const [payoutDaily] = await conn.query(
        `SELECT DATE(created_at) as date,
                SUM(CASE WHEN type = 'roi' THEN amount ELSE 0 END) as roi,
                SUM(CASE WHEN type = 'level_bonus' THEN amount ELSE 0 END) as level_bonus,
                SUM(CASE WHEN type = 'reward_bonus' THEN amount ELSE 0 END) as reward_bonus,
                SUM(amount) as total
         FROM transactions WHERE type IN ('roi','level_bonus','reward_bonus') ${trendClause}
         GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`,
        txFilterParams
      );

      // ── Top performers ──
      const [topInvestors] = await conn.query(
        `SELECT id, username, email, total_invested, total_purchased, total_earned, is_active
         FROM users ORDER BY total_invested DESC LIMIT 10`
      );

      const [topEarners] = await conn.query(
        `SELECT id, username, email, total_earned, total_invested, is_active
         FROM users ORDER BY total_earned DESC LIMIT 10`
      );

      const [topReferrers] = await conn.query(
        `SELECT u.id, u.username, u.email, u.referral_code,
                COUNT(d.id) as direct_count,
                COALESCE(SUM(d.total_purchased), 0) as direct_volume
         FROM users u
         LEFT JOIN users d ON d.sponsor_id = u.id
         GROUP BY u.id
         HAVING direct_count > 0
         ORDER BY direct_count DESC, direct_volume DESC
         LIMIT 10`
      );

      const [planBreakdown] = await conn.query(
        `SELECT plan_type, status, COUNT(*) as count,
                COALESCE(SUM(token_amount), 0) as amount,
                COALESCE(SUM(roi_received), 0) as roi_received
         FROM investments
         GROUP BY plan_type, status`
      );

      const u = userStats[0];
      const inv = invStats[0];
      const tx = txStats[0];
      const totalIncome = Number(tx.total_income_paid);

      res.json({
        success: true,
        generated_at: new Date().toISOString(),
        filters: { date_from: date_from || null, date_to: date_to || null },
        settings: { token_price: tokenPrice, admin_charge_percent: adminChargePercent },
        overview: {
          total_users: Number(u.total_users),
          active_users: Number(u.active_users),
          invested_members: Number(u.invested_members),
          pending_members: Number(u.total_users) - Number(u.invested_members),
          new_today: Number(u.new_today),
          new_week: Number(u.new_week),
          new_month: Number(u.new_month),
          total_invested: Number(u.total_invested),
          total_purchased: Number(u.total_purchased),
          total_earned: Number(u.total_earned),
          total_wallet_usdt: Number(u.total_wallet_usdt),
          total_xit_balance: Number(u.total_xit_balance),
        },
        investments: {
          total: Number(inv.total_investments),
          active: Number(inv.active_investments),
          completed: Number(inv.completed_investments),
          lock_count: Number(inv.lock_count),
          flex_count: Number(inv.flex_count),
          lock_amount: Number(inv.lock_amount),
          flex_amount: Number(inv.flex_amount),
          total_plan_tokens: Number(inv.total_plan_tokens),
          total_roi_received: Number(inv.total_roi_received),
          total_sellable: Number(inv.total_sellable),
          total_locked: Number(inv.total_locked),
          plan_breakdown: planBreakdown.map((p) => ({
            plan_type: p.plan_type,
            status: p.status,
            count: Number(p.count),
            amount: Number(p.amount),
            roi_received: Number(p.roi_received),
          })),
        },
        financial: {
          total_buy_xit: Number(tx.total_buy_xit),
          buy_count: Number(tx.buy_count),
          estimated_buy_usdt: estimatedBuyUsdt,
          total_sell_usdt: Number(tx.total_sell_usdt),
          sell_count: Number(tx.sell_count),
          estimated_admin_sell_revenue: estimatedAdminSellRevenue,
          admin_credits: Number(tx.admin_credits),
          admin_debits: Number(tx.admin_debits),
          total_income_paid: totalIncome,
          net_usdt_in_system: Number(u.total_wallet_usdt),
        },
        income: {
          roi: Number(tx.roi_paid),
          referral: Number(tx.referral_paid),
          level: Number(tx.level_paid),
          reward: Number(tx.reward_paid),
          total: totalIncome,
          breakdown_pct: totalIncome > 0 ? {
            roi: (Number(tx.roi_paid) / totalIncome) * 100,
            referral: (Number(tx.referral_paid) / totalIncome) * 100,
            level: (Number(tx.level_paid) / totalIncome) * 100,
            reward: (Number(tx.reward_paid) / totalIncome) * 100,
          } : { roi: 0, referral: 0, level: 0, reward: 0 },
        },
        network: {
          total_relations: Number(netStats[0].total_relations),
          members_with_team: Number(netStats[0].members_with_team),
          referred_users: Number(netStats[0].referred_users),
          avg_team_size: Number(avgTeam[0].avg_team),
        },
        trends: {
          registrations: regDaily.map((r) => ({ date: r.date, count: Number(r.count) })),
          purchases: buyDaily.map((r) => ({ date: r.date, buy_xit: Number(r.buy_xit), count: Number(r.count) })),
          sales: sellDaily.map((r) => ({ date: r.date, sell_usdt: Number(r.sell_usdt), count: Number(r.count) })),
          payouts: payoutDaily.map((r) => ({
            date: r.date,
            roi: Number(r.roi),
            level_bonus: Number(r.level_bonus),
            reward_bonus: Number(r.reward_bonus),
            total: Number(r.total),
          })),
        },
        top: {
          investors: topInvestors.map((m) => ({
            id: m.id, username: m.username, email: m.email,
            total_invested: Number(m.total_invested),
            total_purchased: Number(m.total_purchased),
            total_earned: Number(m.total_earned),
            is_active: !!m.is_active,
          })),
          earners: topEarners.map((m) => ({
            id: m.id, username: m.username, email: m.email,
            total_earned: Number(m.total_earned),
            total_invested: Number(m.total_invested),
            is_active: !!m.is_active,
          })),
          referrers: topReferrers.map((m) => ({
            id: m.id, username: m.username, email: m.email,
            referral_code: m.referral_code,
            direct_count: Number(m.direct_count),
            direct_volume: Number(m.direct_volume),
          })),
        },
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Business report error:', err);
    res.status(500).json({ error: 'Failed to generate business report' });
  }
}
