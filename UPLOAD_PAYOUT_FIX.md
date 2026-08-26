# Production upload — ROI wrong-user + income_eligible fix

## What your 06:47 / 06:52 logs prove
1. `Unknown column 'i.income_eligible'` → **old** `payoutService.js` still on server
2. `investment 58 userId=50 (sandeep)` then `userId=2 username=m` → credit used **days=2** as user id (stale payout path; `expectedUsername` not deployed)

Local code is already fixed. Server files were not replaced (or Node not restarted).

## Upload THESE files (overwrite on server)
```
backend/services/payoutService.js
backend/services/tokenPayoutService.js
backend/services/investmentService.js
```

## Verify BEFORE restart (SSH or File Manager → Edit)
```bash
cd /home/xittoken/back.xittoken.co
grep -n "PAYOUT_BUILD\|owner_user_id\|income_eligible" services/payoutService.js
```

Must show:
- `PAYOUT_BUILD = '2026-08-26-owner-freeze-v3'`
- `owner_user_id` in SELECT
- **NO** `i.income_eligible` in the active investments SELECT

Also:
```bash
grep -n "WHERE id = \${uid}\|expectedUsername" services/tokenPayoutService.js
```

## phpMyAdmin (required or cron skips / blocks)
```sql
DELETE FROM payout_runs WHERE run_date = '2026-08-26' AND run_type = 'auto';
```

## Restart Node (cPanel → Setup Node.js App → Restart)

## Cron for next test
```
55 6 * * *
```
(or any soon UTC minute) + same command:
```bash
/bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh
```

## Success log (must see build stamp)
```
[Payout] start build=2026-08-26-owner-freeze-v3 ...
[Payout] credit inv=58 owner=50(sandeep) roi=... days=2 wallet=yes
```

If you still see `username=m` or `income_eligible` → file not uploaded or Node not restarted.
