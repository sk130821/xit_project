# ROI payout fix — deploy after local success

## Real bug (found locally)
ROI was credited to the correct user (sandeep/amod), then **level bonus** tried to pay
upline seed user `m` (id=2) who has **no MetaMask wallet**. That threw → **whole
transaction rolled back** → log looked like "wrong userId=2".

## Fix
- `skipIfNoWallet: true` on level / reward / referral bonus credits
- Upline without wallet is skipped; earner ROI still commits
- Cron script prefers **Node (disk)** over HTTP (stale in-memory app)

## Local test result (2026-08-26)
- build: `2026-08-26-skip-nowallet-upline-v4`
- 6/6 investments processed
- ROI ~87.61 XIT on-chain (testnet) to sandeep / amod / amod1
- `m` level bonuses skipped (no wallet)

Note: local DB is `xit_token`. **Production `xittoken_db` still needs this deploy + run.**

## Server steps
```bash
cd /home/xittoken/back.xittoken.co
git pull origin main
```

phpMyAdmin (prod):
```sql
DELETE FROM payout_runs WHERE run_date = '2026-08-26' AND run_type = 'auto';
```

cPanel → Setup Node.js App → **Restart**

Then run once:
```bash
/home/xittoken/nodevenv/back.xittoken.co/20/bin/node scripts/cpanelCron.js
```

## Daily cron (after test works)
```
30 18 * * *
```
= **12:00 AM IST** every day

Command:
```bash
/bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh
```

## Success log
```
[Payout] start build=2026-08-26-skip-nowallet-upline-v4 ...
[Payout] credit inv=58 owner=50(sandeep) ... wallet=yes
[LevelBonus] skipped upline=2 ... reason=no_wallet
[Payout] done processed=6 ... failures=0
```
