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

```bash
/bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh
```

Generic format (kisi aur account ke liye):

```bash
/bin/bash /home/APNA_CPANEL_USERNAME/back.xittoken.co/scripts/cpanel-cron.sh
```

> Script **API** ko `https://back.xittoken.co` par call karti hai — folder path sirf script file ke liye hai.

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
