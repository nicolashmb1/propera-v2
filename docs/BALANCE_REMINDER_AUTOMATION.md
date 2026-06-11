# Balance-triggered rent reminders (automated SMS)

**Status:** Portal-configurable — staff edit in **Settings → Rent reminders**.

**Purpose:** On configurable calendar days (default 5 / 15 / 30), automatically text tenants who have **balance due** via the **broadcast number** (`TWILIO_BROADCAST_FROM`).

**Related:**

- [COMMUNICATION_ENGINE.md](./COMMUNICATION_ENGINE.md)
- `src/dal/portalBalanceReminders.js` — portal CRUD + cron read
- `src/communication/balanceReminderService.js` — cron worker (15-min schedule + send-time gate)

---

## Staff configuration (propera-app)

**Settings → Rent reminders** (`/settings/balance-reminders`)

| Control | What it does |
|---------|----------------|
| **Send rent reminders automatically** | Master on/off for the org |
| **Send time** | Local hour/minute in `PROPERA_TZ` (default 10:00 AM) — not midnight |
| **Per-step On/Off** | Enable/disable individual days |
| **Edit step** | Change day of month, message, min balance, delivery mode |

Default steps seeded on first load:

| Step | Default day | Trigger |
|------|-------------|---------|
| Rent reminder | 5 | balance ≥ 1¢ |
| Late fee warning | 15 | balance ≥ 1¢ |
| Invoice notice | 30 | balance ≥ 1¢ |

---

## Architecture

```text
Every 15 min cron → POST /internal/cron/balance-reminders
  → For each org with balance_reminder_settings.enabled = true
  → Skip unless local time (PROPERA_TZ) is within send window (default 10:00–10:14)
  → Load balance_reminder_rules where enabled
  → If today's day-of-month matches rule.day_of_month
  → Tenants with balance_cents >= min_balance_cents + roster phone + not opt-out
  → Communication Engine campaign → TWILIO_BROADCAST_FROM
  → Audit: balance_reminder_runs + communication_campaigns
```

---

## Database

| Table | Role |
|-------|------|
| `balance_reminder_settings` | Org master `enabled` + `send_hour` / `send_minute` |
| `balance_reminder_rules` | Steps: day, message, threshold, delivery |
| `balance_reminder_runs` | Monthly dedupe + campaign audit |

Migrations: `098_balance_reminder_automation.sql`, `099_balance_reminder_rules_portal.sql`, `100_balance_reminder_send_time.sql`

---

## Operator setup

1. Run migrations **098**, **099**, and **100** in Supabase.
2. Enable Communication Engine + Twilio outbound on V2.
3. Schedule cron every 15 minutes: `POST /internal/cron/balance-reminders` (see `.github/workflows/balance-reminder-cron.yml`).
4. Staff turns on automation and sets send time in **Settings → Rent reminders**.

Staging test (bypass send-time gate): `POST /internal/cron/balance-reminders` with body `{ "forceDay": 5, "forceSend": true }`.

No env-based rule config required for normal operation.

---

## API

| App | V2 |
|-----|-----|
| `GET/PATCH /api/settings/balance-reminders` | `/api/portal/settings/balance-reminders` |
| `PATCH /api/settings/balance-reminders/:ruleKey` | `/api/portal/settings/balance-reminders/:ruleKey` |

Auth: Owner/Ops/PM (settings gate).

---

## Data dependencies

- **Balance:** `tenant_account_snapshots` (Leasehold sync)
- **Phone:** `tenant_roster.phone_e164`
- **Opt-out:** `tenant_roster.comm_broadcast_opt_out`

Run cron after morning balance sync.
