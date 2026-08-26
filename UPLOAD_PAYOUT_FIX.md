# Production upload — wrong-user ROI fix (user m / id=2)

## Root cause
mysql2 prepared `?` params on a reused connection were suspected of binding the wrong
value (ROI `days=2` leaked as `userId=2` → seed user `m`).

## Fix
1. JOIN uses explicit aliases: `owner_user_id`, `owner_username`, `owner_wallet`
2. Owner identity frozen as plain numbers/strings before any credit
3. User lookups use validated integer in SQL (`WHERE id = ${uid}`) — no `?` for user id
4. `expectedUsername` + wallet checks before on-chain send

## Upload these files
- `services/tokenPayoutService.js`
- `services/payoutService.js`

## On server
```bash
cd /home/xittoken/back.xittoken.co
grep -n "owner_user_id\|ownerWallet\|Safety abort" services/payoutService.js
```

phpMyAdmin:
```sql
DELETE FROM payout_runs WHERE run_date = '2026-08-26' AND run_type = 'auto';
```

Then **Restart Node** → Manual Payout or cron.

## Expect log
```
[Payout] credit inv=58 owner=50(sandeep) roi=... days=2 wallet=yes
```
NOT `username=m` / `userId=2`.
