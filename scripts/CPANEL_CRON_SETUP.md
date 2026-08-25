# cPanel Cron — 12:00 AM IST (Daily ROI)

Backend API: **https://back.xittoken.co/api**

---

## Step 1 — Apna sahi path kaise dhundhein

`virajnandani` ya purana hosting username **use mat karo** — naye account ka alag username hoga.

1. **cPanel → File Manager**
2. `back.xittoken.co` folder kholo (jahan `server.js`, `package.json`, `.env` hain)
3. `scripts` folder → `cpanel-cron.sh` file
4. File par right-click → **Copy path** (ya address bar se full path dekho)

Path hamesha is format me hota hai:

```
/home/APNA_CPANEL_USERNAME/back.xittoken.co/scripts/cpanel-cron.sh
```

**cPanel username** top-right corner ya **General Information** me dikhta hai (purana `virajnandani` nahi).

---

## Step 2 — Cron Jobs (copy settings)

**cPanel → Cron Jobs → Add New Cron Job**

| Field | Value |
|-------|--------|
| **Minute** | `30` |
| **Hour** | `18` |
| **Day** | `*` |
| **Month** | `*` |
| **Weekday** | `*` |

**Command** — aapke server par (username `xittoken`):

**Option A — recommended (browser jaisa, `.env` ki zaroorat nahi):**

```bash
/usr/bin/curl -sS -H "x-cron-secret: your_cron_secret_sandeep" "https://back.xittoken.co/api/cron/daily-payout?secret=your_cron_secret_sandeep" >> /home/xittoken/back.xittoken.co/logs/cron.log 2>&1
```

`your_cron_secret_sandeep` ko apne real secret se replace karo (cPanel Environment Variables wala).

**Option B — bash script** (`.env` file me `CRON_SECRET=` line **zaroori**):

```bash
/bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh
```

> Browser URL chalna ≠ cPanel cron chalna. Browser Node app ko call karta hai (cPanel UI secret). Bash script **`.env` file** padhti hai — agar wahan secret nahi to cron fail.

---

## Kyon 18:30 UTC?

Server timezone **UTC** ho to:

| UTC (server) | IST (India) |
|--------------|-------------|
| 18:30 | **00:00** midnight |

Roz **raat 12 baje IST** par ROI.

---

## Server `.env` (`back.xittoken.co/.env`)

```env
AUTO_ROI_CRON=false
CRON_SECRET=apna_strong_random_secret
```

### Important: cPanel UI ≠ `.env` file

Agar aapne **Setup Node.js App → Environment Variables** me `CRON_SECRET` dala hai,  
wo **sirf Node server** ke liye hai — **cron bash script `.env` file padhti hai**.

Dono jagah **same value** honi chahiye:

1. cPanel Environment Variables: `CRON_SECRET=your_cron_secret_sandeep`
2. File `/home/xittoken/back.xittoken.co/.env` me bhi same line:

```bash
cd /home/xittoken/back.xittoken.co
echo 'CRON_SECRET=your_cron_secret_sandeep' >> .env
grep CRON_SECRET .env
```

Phir **Restart** Node app.

---

## Manual test (browser)

```
https://back.xittoken.co/api/cron/daily-payout?secret=APNA_CRON_SECRET
```

- Pehli baar: `"ok": true`
- Same IST din dubara: `"skipped": true`

---

## Log file

```
/home/xittoken/back.xittoken.co/logs/cron.log
```

---

## Galat setup (mat karo)

- `* * * * *` — har minute
- Purana path: `xit.back.virajnandanigold.com`
- Do cron jobs same kaam ke liye
- `AUTO_ROI_CRON=true` + cPanel cron dono

---

## Cron nahi chala? — Fix checklist

### Log me: `CRON_SECRET missing`

Server terminal:

```bash
cd /home/xittoken/back.xittoken.co
nano .env
```

Yeh line **add** karo (ya edit karo) — koi space `=` ke around mat rakho:

```env
CRON_SECRET=XitCron2026_SecureKey_ChangeMe
```

Save karo, phir:

```bash
grep CRON_SECRET .env
```

cPanel → **Setup Node.js App** → **Restart**

Test:

```bash
/bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh
tail -5 /home/xittoken/back.xittoken.co/logs/cron.log
```

Browser:

```
https://back.xittoken.co/api/cron/daily-payout?secret=XitCron2026_SecureKey_ChangeMe
```

(Secret wahi jo `.env` me likha ho)

---

1. Latest `scripts/cpanel-cron.sh` upload karo + Node app **Restart**
2. `.env` me `CRON_SECRET=...` (server wala) — browser test se match karo
3. Log: `/home/xittoken/back.xittoken.co/logs/cron.log`
4. **cPanel timezone** dekho:
   - **UTC** → `30 18 * * *` (12 AM IST)
   - **IST** → `0 0 * * *` (12 AM IST)
5. Test 2 min baad (UTC server): abhi IST + 2 min → UTC me convert karke minute/hour set karo
6. SSH: `cd /home/xittoken/back.xittoken.co && node scripts/testCron.js`
