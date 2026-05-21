# Tenant portal — Vercel demo (tomorrow)

Minimal setup: **app on Vercel**, **API on your machine via ngrok** (or any public V2 URL).

## 1. Vercel — add these env vars

In the Vercel project → **Settings → Environment Variables** (Production + Preview):

| Variable | Value |
|----------|--------|
| `DEV_ORG_SUBDOMAIN` | `thegrand` |
| `PROPERA_V2_API_URL` | `https://YOUR-NGROK-HOST/api/portal/gas-compat` |
| `PROPERA_V2_WEBHOOK_URL` | `https://YOUR-NGROK-HOST/webhooks/portal` |
| `PROPERA_PORTAL_TOKEN` | Same as `propera-v2` `.env` |
| `NEXT_PUBLIC_TENANT_DEV_OTP_BYPASS` | `1` |
| `SUPABASE_*` | Already set on your project |

Redeploy after saving vars.

`*.vercel.app` hosts use `DEV_ORG_SUBDOMAIN` (same as localhost).

## 2. propera-v2 — must be reachable from the internet

Vercel calls V2 server-side. Easiest for a one-day demo:

```bash
cd propera-v2
npm start
# second terminal:
ngrok http 8080
```

Put the ngrok HTTPS origin in `PROPERA_V2_API_URL` / `PROPERA_V2_WEBHOOK_URL` on Vercel.

**V2 `.env` must include:**

```
TENANT_JWT_SECRET=propera-tenant-dev-secret-min-32-characters-local
TENANT_DEV_OTP_BYPASS=1
TENANT_DEV_OTP_CODE=000000
DEV_ORG_SUBDOMAIN=thegrand
```

Keep the laptop on during the demo (ngrok + V2).

## 3. Your login (no SMS)

Open on your phone:

`https://YOUR-VERCEL-APP.vercel.app/tenant/login`

(Note: `/tenant/login`, not `tenanat`.)

1. Phone: **`9083380390`** or **`+19083380390`**
2. Tap send code
3. Code: **`000000`**
4. Continue → dashboard

Dev bypass works for **any** roster phone — no need to lock to only yours. Nobody else will hit the URL.

## 4. If login says “account not found”

Your number must be on **`tenant_roster`** for a Grand property (`PENN`, etc.) with `portal_enabled = true`.

Check in Supabase SQL:

```sql
select id, property_code, unit_label, resident_name, phone_e164, active, portal_enabled
from tenant_roster
where phone_e164 in ('+19083380390', '+19083380300');
```

If missing, add one row (example):

```sql
insert into tenant_roster (property_code, unit_label, resident_name, phone_e164, active, portal_enabled)
values ('PENN', 'DEMO', 'Nick', '+19083380390', true, true);
```

## 5. Tomorrow checklist

- [ ] `ngrok http 8080` running → Vercel env URLs updated
- [ ] `npm start` in `propera-v2`
- [ ] Vercel redeployed with vars above
- [ ] One test login on your phone

That’s it.
