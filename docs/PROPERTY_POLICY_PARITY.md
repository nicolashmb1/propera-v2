# Property policy parity (GAS ↔ V2)

**Goal:** `validateSchedPolicy_` in V2 reads the same facts GAS reads from **PropertyPolicy** (`ppGet_` merge GLOBAL + property).

**Related:** inbound routing order and SMS-only compliance — **[ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md)**.

## Source of truth in V2

- Table: `property_policy` (see `src/dal/propertyPolicy.js`, `getSchedPolicySnapshot`)
- Seed / examples: `supabase/migrations/004_roster_and_policy_seed.sql`

## Operator checklist (when changing GAS PropertyPolicy sheet)

1. For each property code that has custom hours or weekend rules, ensure a row exists with `property_code` = that code (uppercase).
2. GLOBAL row keys (`SCHED_EARLIEST_HOUR`, `SCHED_LATEST_HOUR`, `SCHED_ALLOW_WEEKENDS`, …) must match the sheet’s effective values after merge.
3. Align **`PROPERA_TZ`** / **`TZ`** and **`PROPERA_SCHED_LATEST_HOUR`** with GAS `Session.getScriptTimeZone()` and `ppGet_('GLOBAL','SCHED_LATEST_HOUR',17)` so parse + policy see the same local hours.

## SMS opt-out (router parity)

- Migration: `011_sms_opt_out.sql` — stores compliance STOP/START per `actor_key` (`RouterParameter.From`).
- Code: `src/dal/smsOptOut.js`; **`runInboundPipeline`** applies persistence + suppression only when **`transportChannel === "sms"`** — not WhatsApp or Telegram (`src/inbound/transportCompliance.js`).
- Twilio webhooks: `POST /webhooks/twilio` or `POST /webhooks/sms` (form body). WhatsApp uses the same handler; `From` prefix `whatsapp:` sets channel to WA (no SMS compliance side effects).

No automatic sync from GAS sheets — run migration on Supabase when enabling production router parity.
