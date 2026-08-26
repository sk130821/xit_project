# Production upload — ROI wrong-user + income_eligible fix

## Root cause of 07:00 failure (still userId=2 / m)
`cpanel-cron.sh` was calling **HTTP** `https://back.xittoken.co/api/cron/daily-payout` first.
That hits the **long-running Node app** (old code in memory).
`git pull` updates disk files, but HTTP keeps serving old JS until **cPanel → Restart**.

Indented `Payout failed...` lines in cron.log are the **HTTP JSON body**, not Node fallback.

## Fix applied
- Cron default mode is now **Node first** (reads disk after every `git pull`)
- Response includes `payoutBuild: 2026-08-26-owner-freeze-v3`

## On server NOW
```bash
cd /home/xittoken/back.xittoken.co
git pull origin main

# phpMyAdmin:
# DELETE FROM payout_runs WHERE run_date = '2026-08-26' AND run_type = 'auto';

# Optional but recommended: cPanel → Setup Node.js App → Restart

# Manual test (disk files, no wait for cron):
/home/xittoken/nodevenv/back.xittoken.co/20/bin/node scripts/cpanelCron.js
```

## Expect log
```
[Payout] start build=2026-08-26-owner-freeze-v3 ...
[Payout] credit inv=58 owner=50(sandeep) ... wallet=yes
```
NOT `username=m` / `userId=2`.
