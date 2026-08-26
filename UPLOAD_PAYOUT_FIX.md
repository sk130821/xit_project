# Production upload — orphan cleanup + payout user-id fix

## 1) Upload these backend files
- `services/tokenPayoutService.js`
- `services/payoutService.js`
- `services/payoutDebugService.js` (if not already)
- `controllers/cronController.js`
- `scripts/cleanupOrphanInvestments.js`
- `scripts/debugPayout.js`
- `migrations/009_cleanup_orphan_investments.sql`

## 2) On server — cleanup orphans
```bash
cd /home/xittoken/back.xittoken.co
node scripts/cleanupOrphanInvestments.js
```

Or phpMyAdmin SQL:
```sql
DELETE i FROM investments i
LEFT JOIN users u ON u.id = i.user_id
WHERE u.id IS NULL;
```

## 3) Clear today's empty auto run (so cron can run again)
```sql
DELETE FROM payout_runs
WHERE run_date = '2026-08-26' AND run_type = 'auto';
```

## 4) Restart Node app in cPanel

## 5) Test
```text
https://back.xittoken.co/api/cron/debug-payout?secret=YOUR_CRON_SECRET
```
Then Manual Payout or cron.

## What was fixed
1. Delete investments whose users were deleted (A1–C1 orphans)
2. Payout only processes investments INNER JOINed to existing users
3. Strict integer userId — rejects ROI floats mistaken as ids
4. Verify DB user row id + username match investment owner before credit
5. Clearer failure logs with username
