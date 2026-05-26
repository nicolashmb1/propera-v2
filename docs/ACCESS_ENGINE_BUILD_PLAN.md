# Access Engine — build plan (V1)

**Purpose:** Design north and phased build plan for **time-gated physical amenity access** (sauna, terrace, gameroom, etc.). Propera owns **reservation lifecycle, schedule truth, and credential issuance**. Smart locks are **output devices** via a swappable **lock adapter** — vendor chosen after the engine is proven.

**Audience:** product, engineering, next agent implementing access + staff cockpit.

**Status:** **Partially shipped** — migrations **057** and **058**, V2 Access engine + portal API + tenant access API, propera-app **`/access`** command center + config UI, tenant **`/tenant/amenities`** surfaces, and QR/public reserve shell are live. **Not started:** inbound ACCESS_* router/channel path, access lifecycle worker (`CONFIRMED → ACTIVE → COMPLETED/NO_SHOW`), real lock adapters, and Tenant Agent access handoff.

**Naming:** **Access Engine** (product). Code module prefix: `access` (e.g. `src/access/`). Staff nav label: **Access** (`/access`). Avoid overloading “amenity” in table names unless we standardize later — tables use `access_*`.

**Related:**

- [AGENTS.md](../AGENTS.md) · [PROPERA_GUARDRAILS.md](../../propera-gas-reference/PROPERA_GUARDRAILS.md) · [PROPERA_NORTH_COMPASS.md](../../propera-gas-reference/PROPERA_NORTH_COMPASS.md)
- [ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md) — where inbound intents attach (new lane / router branch; must not hijack maintenance core)
- [ADAPTER_ONBOARDING.md](./ADAPTER_ONBOARDING.md) — channel adapters stay transport-only
- [TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md) — structured tenant reserve/cancel/status via `/tenant/*`
- [COMMUNICATION_ENGINE.md](./COMMUNICATION_ENGINE.md) — precedent for a **bounded engine** separate from `handleInboundCore`
- [TENANT_AGENT_ADAPTER.md](./TENANT_AGENT_ADAPTER.md) — current maintenance-only lane; future access/amenity handoff
- [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) — deposit capture/refund hooks (wire when finance phase allows)
- [propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md](../../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md) — cockpit vs brain
- [PARITY_LEDGER.md](./PARITY_LEDGER.md) — add rows when behavior ships (no GAS parity required for net-new domain)

---

## North compass alignment

| Principle | How Access Engine honors it |
|-----------|----------------------------|
| **Signal → Brain → Outgate** | Tenant/staff inputs normalize to a **canonical access signal**; **Access Engine** decides availability, approval, credentials; **lock adapter** executes; **outgate** confirms on originating channel. |
| **Channel-agnostic** | Same engine for SMS, WhatsApp, Telegram, tenant portal, and future app surfaces — only adapter + outgate template differ. |
| **Interpretation once** | Router/compiler resolves **which location, which window, which tenant** — Access Engine does not re-parse NL in multiple places. |
| **AI is not control** | NL on SMS may use AI **extraction** only; **policy + availability + state machine** are deterministic in V2. |
| **Multi-org, DB-driven** | Every location, policy, schedule, and lock row is scoped by **`org_id`** (+ `property_id`). No property names or PIN rules in code. |
| **propera-app is cockpit** | Staff **configures policy**, **views calendar**, **overrides** reservations — writes go through **V2 portal routes**, not parallel brain in Next.js. |

**Explicit boundary:** Access Engine is **not** maintenance lifecycle. It must **not** run inside `handleInboundCore` or mutate `tickets` / `work_items` for reservations. Optional **timeline/event_log** links are display-only audit — not ticket state.

## Current reality (2026-05)

**Shipped now**

- Supabase **`access_*`** schema is live (locations, policies, schedules, blackouts, reservations, passes, locks, audit).
- V2 Access DAL / engine is live (`src/access/*`, `src/dal/accessEngine.js`) with deterministic availability and booking checks.
- Staff portal routes are live (`registerAccessRoutes.js`) for location CRUD, policy/schedule updates, reservation actions, PIN regenerate, and staff override booking.
- Tenant access routes are live under **`/api/tenant/access/*`** with reservation create/cancel and QR/public reserve identify flow.
- propera-app staff **`/access`** and **`/access/locations/[id]/config`** are live.
- propera-app tenant **`/tenant/amenities`** and reservation detail flow are live.

**Still not started / incomplete**

- Inbound ACCESS_* router branch for SMS / WhatsApp / Telegram.
- Access-specific outgate templates and reminders.
- Lifecycle worker for reservation status progression and pass expiry/revoke.
- Real lock providers beyond **`noop`**.
- Deposit / finance hooks.
- Tenant Agent access handoff (today Access/amenity requests are still deflected by the maintenance-only lane).

---

## Problem statement

Controlled-access rooms (gameroom, sauna, terrace, etc.) need:

1. **Bookable windows** with conflict detection and per-tenant limits.
2. **Credentials** (PIN, QR, mobile key) valid only for the reserved window.
3. **Staff command center** to see what is booked, who booked, approve/cancel/override, and manage blackouts.
4. **Pilot without hardware** — full lifecycle with **Noop lock adapter** (manual PIN / staff confirm) until vendor API is chosen.

---

## Architecture overview

```text
Tenant / staff input (any channel)
  → Adapter (transport only — Twilio, Telegram, portal HTTP, …)
  → Signal normalize (Canonical Access Signal Package)
  → Router → intent: ACCESS_RESERVE | ACCESS_CANCEL | ACCESS_STATUS | ACCESS_LIST_SLOTS
  → Context compiler (location alias, tenant roster, property, time window)
  → Access Engine (authoritative)
       → getActivePolicy(locationId)
       → canReserve() / conflict / limits / eligibility
       → reservation state machine
       → deposit hook (Finance — async when ready)
       → issue / revoke credential via LockAdapter
  → Outgate → tenant/staff message on originating channel
```

```text
Staff cockpit (propera-app)
  → /access/* UI (read models + forms)
  → /api/access/* Next proxies (auth + portal token)
  → propera-v2 /api/portal/access/* (or dedicated /api/access/* — pick one prefix in implementation)
  → Supabase access_* tables + engine services
```

**Comparison to Communication Engine:** Shallow broadcast engine avoids the maintenance brain. Access Engine is **deeper** (state machine + schedule truth) but still a **dedicated domain** — not a second maintenance interpreter.

### Tenant Agent role (future, explicit)

Tenant Agent should participate in Access as the **communication layer between tenant and the Access brain**, not as the reservation authority.

- **Agent may own:** conversational gather, clarification, ambiguity resolution, and deep-link / handoff UX.
- **Agent must not own:** availability truth, conflict decisions, policy enforcement, deposit state, credential issuance, or reservation lifecycle state.
- **Access Engine owns:** deterministic reservation policy, state machine, pass issuance/revoke, reminders, and audit trail.
- **Integration seam:** Agent gathers `location`, `window`, and `intent` (`reserve`, `cancel`, `status`, `list_slots`) then hands off a **canonical access signal package** to the Access domain. It must route **beside** `handleInboundCore`, not through maintenance intake.
- **Safe rollout order:** keep today's deflect behavior as fallback; add deep links to existing tenant amenities surfaces first; add true ACCESS_* handoff only after Access lifecycle + outgate are production-solid.

---

## Repo split

| Repo | Responsibility |
|------|----------------|
| **propera-v2** | Schema, DAL, `src/access/*` engine, lock adapters, router handlers, portal API routes, cron/scheduler for ACTIVE→COMPLETED and credential expiry, outgate templates. |
| **propera-app** | Staff **Access** module: location list, policy config tabs, reservation calendar (day/week), reservation detail actions, blackouts, lock status panel, stats bar. Proxies only — no reservation business logic in Next.js. |
| **Supabase** | `access_*` tables, RLS by org; portal read views optional later (`portal_access_*_v1`). |

---

## Data model (V1)

All tables include **`org_id`** (FK → `organizations` when present). **`property_id`** or **`property_code`** follows existing V2 convention (`properties.code`). **`tenant_id`** = **`tenant_roster.id`**.

### Core entities

| Table | Purpose |
|-------|---------|
| **`access_locations`** | Bookable space: name, description, `property_code`, capacity (`max_concurrent` denorm or policy-only), `active`, display sort. |
| **`access_location_policies`** | Versioned rules (see Policy layer). One **active** row per location by `effective_from` / `effective_until`. |
| **`access_schedules`** | Recurring weekly hours per location (`day_of_week`, `open_time`, `close_time`, optional `effective_from` / `effective_until`). |
| **`access_blackouts`** | One-off closures (`start_at`, `end_at`, `reason`, `created_by`). |
| **`access_reservations`** | Booking record (state machine below). |
| **`access_passes`** | Issued credential bound to reservation + lock. |
| **`access_locks`** | Lock abstraction row per location (0..n; pilot often 1). |
| **`access_policy_audit`** | Who changed policy fields, when (staff accountability). |
| **`access_policy_templates`** | *(V1 schema only, UI later)* Org-level named snapshots to seed new locations. |

### `access_locations` (columns)

| Column | Notes |
|--------|--------|
| `id` | uuid PK |
| `org_id` | text/uuid per org table |
| `property_code` | e.g. `PENN` — resolved from DB, never coded in engine |
| `slug` | optional stable key for NL (“gameroom”) |
| `name`, `description` | staff + tenant display |
| `active` | bool |
| `created_at`, `updated_at` | |

### `access_location_policies` (columns)

Policy is **the** rules source — engine never reads limits off `access_locations` directly.

| Group | Fields |
|-------|--------|
| **Booking window** | `min_duration_min`, `max_duration_min`, `advance_booking_min`, `advance_booking_max_days`, `same_day_allowed` |
| **Capacity** | `max_concurrent`, `max_per_tenant_day`, `max_per_tenant_week`, `max_per_tenant_month` |
| **Approval** | `requires_approval`, `approval_timeout_min`, `approval_timeout_action` (`auto_cancel` \| `auto_approve`) |
| **Pricing** | `deposit_amount`, `deposit_refundable`, `deposit_refund_cutoff_hours`, `hourly_rate` (0 = free) |
| **Eligibility** | `eligible_tenants` (`all` \| `unit_whitelist` \| `lease_active_only`), `guest_allowed`, `max_guests` |
| **Notifications** | `reminder_before_min`, `staff_notify_on_reserve`, `staff_notify_on_cancel`, `staff_notify_reminder_copy` |
| **Meta** | `location_id`, `org_id`, `effective_from`, `effective_until`, `created_by`, `updated_at` |

**Engine API:** `getActivePolicy(locationId, at?: Date)` — single lookup used by `canReserve()`, approval timeouts, and deposit rules.

### `access_reservations`

| Column | Notes |
|--------|--------|
| `location_id`, `tenant_id`, `org_id` | |
| `start_at`, `end_at` | timestamptz |
| `status` | see state machine |
| `channel` | `sms` \| `whatsapp` \| `telegram` \| `tenant_portal` \| `portal` \| `staff_override` |
| `deposit_amount`, `deposit_status`, `deposit_ref` | Finance hooks |
| `access_pass_id` | FK nullable until issued |
| `notes`, `override_by`, `approved_by`, `cancelled_by` | staff audit |
| `created_at`, `updated_at` | |

### `access_passes`

| Column | Notes |
|--------|--------|
| `reservation_id`, `lock_id` | |
| `credential_type` | `pin` \| `qr` \| `mobile_key` \| `card` |
| `credential_value_enc` | encrypted at rest |
| `valid_from`, `valid_until` | |
| `status` | `PENDING` \| `ISSUED` \| `ACTIVE` \| `REVOKED` \| `EXPIRED` |
| `issued_at`, `revoked_at`, `revoked_by` | |

### `access_locks`

| Column | Notes |
|--------|--------|
| `org_id`, `location_id` | |
| `provider` | `noop` \| `seam` \| `august` \| `nuki` \| … |
| `external_lock_id` | provider id |
| `config` | jsonb — provider credentials (server env refs, not secrets in row) |
| `active` | |

---

## Reservation state machine

```text
REQUESTED
  → [deposit required & unpaid] → PENDING_DEPOSIT → [paid] → CONFIRMED
  → [no deposit / auto] → CONFIRMED
  → [requires_approval] → PENDING_APPROVAL → [approved] → CONFIRMED
  → [denied] → CANCELLED

CONFIRMED
  → [job at start_at] → ACTIVE        (lock adapter: issue credential)
  → [staff manual override] → ACTIVE

ACTIVE
  → [job at end_at] → COMPLETED       (lock adapter: revoke)
  → [cancel / staff] → CANCELLED      (+ revoke)

Terminal: CANCELLED | COMPLETED | NO_SHOW
```

**`NO_SHOW`:** window ended without entry signal (adapter log or manual staff mark) — credential expired/revoked.

**Scheduler:** V2 cron or Supabase pg_cron triggers: `CONFIRMED→ACTIVE`, `ACTIVE→COMPLETED`, approval timeouts, reminder outgate, `PENDING_DEPOSIT` expiry.

---

## Policy-driven engine (no hardcoded rules)

```javascript
// Conceptual — implementation in src/access/canReserve.js
async function canReserve({ locationId, tenantId, startAt, endAt }) {
  const policy = await getActivePolicy(locationId, startAt);
  checkDuration(policy, startAt, endAt);
  checkAdvanceWindow(policy, startAt);
  checkBlackouts(locationId, startAt, endAt);
  checkWeeklySchedule(locationId, startAt, endAt);
  checkCapacity(policy, locationId, startAt, endAt);
  checkTenantLimits(policy, tenantId, locationId, startAt);
  checkEligibility(policy, tenantId);
  return {
    allowed: boolean,
    reason?: string,
    requiresApproval: policy.requires_approval,
    depositAmount: policy.deposit_amount,
  };
}
```

Swap policy row → behavior changes without deploy. **Pilot:** seed PENN Gameroom location + policy via migration **or** staff UI after Phase B.

---

## Lock adapter interface

Provider-agnostic contract in `src/access/lockAdapter/types.js` (or TypeScript declaration file if we add types later):

```typescript
interface LockAdapter {
  issueCredential(lockId: string, validFrom: Date, validUntil: Date, ctx: IssueContext): Promise<AccessCredential>
  revokeCredential(lockId: string, credentialId: string): Promise<void>
  getStatus(lockId: string): Promise<LockStatus>
  getLogs(lockId: string, from: Date, to: Date): Promise<AccessEvent[]>
}
```

| Implementation | When |
|----------------|------|
| **`NoopAdapter`** | Pilot — generates PIN in DB, staff notified; physical lock set manually |
| **`SeamAdapter`** | After vendor decision (historical Seam familiarity in org) |
| **`AugustAdapter` / `NukiAdapter`** | As needed |
| **Factory** | `getLockAdapter(provider)` from `access_locks.provider` |

**Security:** Never log plaintext PIN; encrypt `credential_value_enc`; portal APIs return masked PIN except to authenticated tenant for their own active reservation window.

---

## Inbound intents (channel-agnostic)

| Intent | Tenant examples | Portal |
|--------|-----------------|--------|
| **ACCESS_RESERVE** | “Book gameroom Saturday 3-5” | Form: location, date, duration |
| **ACCESS_CANCEL** | “Cancel my gameroom booking” | Cancel button |
| **ACCESS_STATUS** | “When is my sauna booking?” | My reservations list |
| **ACCESS_LIST_SLOTS** | “What’s free tomorrow afternoon?” | Slot picker API |

**Router:** Add precursors in `routeInboundDecision` / lane map — route to `src/access/handleAccessInbound.js`, **not** `handleInboundCore`.

**NL path:** Optional compile step extracts `location_slug`, `start_at`, `end_at` → structured package → engine. **Portal path:** JSON body already structured — same engine entrypoint.

**Outgate templates (examples):**

- Offer slot + deposit quote → confirm prompt
- Confirmed + PIN + validity window
- Denied + reason (conflict, limit, blackout)
- Reminder `reminder_before_min` before start
- Expired / revoked

---

## Deposit / Finance integration

| Phase | Behavior |
|-------|----------|
| **Pilot** | `deposit_amount = 0` — skip `PENDING_DEPOSIT` |
| **Later** | `PENDING_DEPOSIT` → payment link or ledger charge via Finance layer; `deposit_ref` stores payment id; refund rules use `deposit_refund_cutoff_hours` |

Do not implement payment processors inside `src/access/` — call Finance APIs/hooks documented in **PROPERA_FINANCE_ROADMAP**.

---

## Staff cockpit — propera-app `/access`

**Module:** Owner/staff only (same session + role gates as tickets/preventive). Feature flag recommended: `NEXT_PUBLIC_PROPERA_ACCESS_ENABLED=1` (mirrors preventive pattern).

### UI design contract (mandatory)

All Access screens **must match existing propera-app design** — same patterns as `/tickets`, `/preventive`, `/financial`:

- **`AppLayout`** shell, **`Ic`** icons, **`LoadingSkeleton`**, **`ErrorState`**, **`RefreshButton`**
- **Dark theme** — CSS variables from `globals.css` / `AppLayout` `SHARED_STYLES`; no hardcoded one-off colors
- **Mobile-first** — `useIsNarrow`; usable at 375px width
- **No new component libraries** (no shadcn/MUI/Radix)
- **Thin API routes** — validate session, forward to V2 with `PROPERA_PORTAL_TOKEN`; **`invalidateCache()`** after writes
- **TypeScript strict** — types in `src/lib/types.ts` or `src/lib/accessTypes.ts`

Reference implementations: `src/app/preventive/page.tsx`, `src/app/tickets/page.tsx`, ticket detail panels.

### Information architecture

```text
/access                          Command center (default)
/access/locations               Location list (all properties in org)
/access/locations/[id]          Location hub → calendar default tab
/access/locations/[id]/calendar Day / week grid
/access/locations/[id]/config   Policy config (tabbed)
/access/locations/new           Create location wizard
```

### Command center layout (`/access` or location hub)

| Region | Content |
|--------|---------|
| **Left sidebar** | All `access_locations` for org; property tag; status dot (active / blackout / full); **Add location** |
| **Top bar** | Selected location + property; date nav ◀ ▶; **Day \| Week** toggle; **Staff override** (manual reservation) |
| **Stat bar** | Today’s count, active now, pending approval, week utilization % — from V2 aggregates API |
| **Calendar grid** | Hourly rows; blocks colored by **status** (teal ACTIVE, green CONFIRMED, amber PENDING_*, grey CANCELLED); **NOW** line; empty slots visible |
| **Detail panel** (slide/over on click) | Tenant name, unit, channel icon, status pill, time range, duration, PIN (masked/reveal), deposit status, notes; **context actions** |

### Detail panel actions (status-aware)

| Status | Actions |
|--------|---------|
| `PENDING_APPROVAL` | Approve, Deny |
| `PENDING_DEPOSIT` | Mark paid (staff), Cancel |
| `CONFIRMED` | Cancel + revoke, Regenerate PIN |
| `ACTIVE` | Extend window, Revoke now, Complete early |
| Any (staff) | Edit notes, Override audit trail |

### Config UI — `/access/locations/[id]/config`

Tabbed panel; each tab maps 1:1 to `access_location_policies` field groups:

| Tab | Fields |
|-----|--------|
| **General** | Name, description, property, active, lock assignment dropdown |
| **Availability** | Weekly schedule builder; max concurrent |
| **Booking rules** | Min/max block, advance notice, book-ahead days, same-day, per-tenant day/week/month limits |
| **Approval** | Auto-confirm vs requires approval; timeout + on-timeout action |
| **Pricing** | Deposit, refundable, refund cutoff hours, hourly rate |
| **Access rules** | Eligible tenants mode, guests, max guests |
| **Notifications** | Tenant reminder; staff notify toggles |

**Policy save:** POST creates new policy version or updates with `effective_from` — engine always uses `getActivePolicy`.

### Blackouts & locks

- **Blackout manager** on location hub: date range + reason → blocks bookings in `canReserve`
- **Lock status panel** (when provider ≠ `noop`): online/offline, battery, last event — read-only from adapter `getStatus` / `getLogs`

### Visibility requirements (staff)

Staff must always see:

- What is **booked** vs **open** for any day/week
- **Who** booked (tenant + unit)
- **Channel** (SMS, portal, …)
- **Reservation status** and **credential status**
- **Override / approval** audit (`override_by`, `approved_by`, timestamps)

---

## Tenant surfaces

| Surface | Path | Notes |
|---------|------|--------|
| **SMS / WA / Telegram** | *Future* existing webhooks / Tenant Agent handoff → access router branch | Current safe behavior is deflect; later phases replace deflect with Access handoff or deep link |
| **Tenant portal** | `/tenant/amenities` | Full portal nav; OTP login |
| **QR door (pilot)** | `/tenant/reserve/{propertyCode}/{slug}` | No OTP; unit + phone identify |
| **Owner app** | Future | Same signal package |

### QR door flow (pilot constraints)

- **No SMS OTP** — Twilio campaign not approved; QR must not use `/tenant/login`.
- **Location-scoped URL** — e.g. `https://thegrand.usepropera.com/tenant/reserve/PENN/gameroom` (org from host).
- **Identify** — `POST /api/tenant/auth/identify` with unit + phone; must match `tenant_roster` at that `property_code`.
- **Book** — same Access Engine APIs; reservation `channel = qr_portal`.
- **Branded** — minimal shell (no full portal nav); success shows door code when issued.

Tenant portal amenities list still requires normal OTP login. QR path is intentionally narrow.

---

## Pilot — PENN Gameroom

| Step | Action |
|------|--------|
| 1 | Migration: org-scoped `access_locations` row — property `PENN`, name “Gameroom” |
| 2 | Policy: e.g. daily 08:00–23:00, 30–120 min blocks, `max_concurrent = 1`, deposit $0, auto-confirm |
| 3 | `access_locks` row — `provider = noop` |
| 4 | Enable inbound ACCESS_* intents for tenants on PENN roster |
| 5 | Staff notifications on reserve/cancel (SMS or portal toast — TBD) |
| 6 | Run 2–4 weeks real bookings; tune policy via propera-app config |
| 7 | Select lock vendor → implement adapter → **no engine/schema change** beyond `provider` + `config` |

**Seed data only:** Penn/Gameroom names appear in SQL seed or staff UI — **zero** `if (property === 'PENN')` in engine code.

---

## Out of scope (V1)

- Lock hardware purchase / install
- Payment processor for deposits (hook only)
- Group bookings / party size > 1 concurrent credential
- Waitlist, recurring reservations
- IoT entry detection (optional input to `NO_SHOW` later)
- GAS parity / Sheet sync

---

## Phased build order

| Phase | Deliverable | Repo |
|-------|-------------|------|
| **A — Schema** | Migration `057_access_engine_v1.sql` (coordinate number with finance roadmap); tables above + indexes + RLS | v2 |
| **B — Engine core** | `getActivePolicy`, `canReserve`, conflict detection, state machine, DAL | v2 |
| **C — NoopAdapter** | Issue/revoke PIN; scheduler jobs | v2 |
| **D — Portal API** | CRUD locations, policies, reservations, blackouts; staff override; calendar feed | v2 |
| **E — Router + outgate** | ACCESS_* intents; templates; Tenant Agent/deep-link handoff seam | v2 |
| **F — Staff UI** | `/access` command center + config tabs + proxies | app |
| **G — Tenant portal slice** | `/tenant/amenities` + `/api/tenant/access/*` + QR/public reserve | app + v2 |
| **H — Real lock adapter** | Seam/August/… after vendor pick | v2 |

**Tests (V2):** `tests/accessCanReserve.test.js`, `tests/accessStateMachine.test.js`, golden NL compile fixtures when router ships.

**Docs to update when shipping:** this file (status), **PARITY_LEDGER** (new domain row), **BRAIN_PORT_MAP** (access engine table), **AGENTS.md** (optional read), **OUTSIDE_CURSOR** (migration + env), **HANDOFF_LOG** (dated section).

---

## Migration & env (placeholder)

| Item | Notes |
|------|--------|
| **Migration** | `057_access_engine_v1.sql` — confirm next free number before apply |
| **Env** | Lock provider secrets per adapter (e.g. `SEAM_API_KEY`) — document in `.env.example` when H ships |
| **Feature flag** | `NEXT_PUBLIC_PROPERA_ACCESS_ENABLED` in propera-app |

---

## Open decisions (resolve in implementation PR)

1. **API prefix:** `/api/portal/access/*` vs `/api/access/*` on V2 server.
2. **Unit whitelist storage:** jsonb on policy vs join table `access_location_eligible_units`.
3. **Entry detection for NO_SHOW:** noop vs webhook from lock vendor.
4. **Staff notify channel:** SMS to duty phone vs in-app only.

---

## Acceptance criteria (V1 done)

- [ ] Tenant can reserve PENN Gameroom via SMS (or portal) and receive PIN + window in reply.
- [ ] Conflicting slot is rejected with clear reason.
- [ ] Staff sees day calendar with booked/open slots and reservation detail.
- [ ] Staff can approve, cancel, override, regenerate PIN from propera-app.
- [ ] Policy changes in config UI affect new bookings without code deploy.
- [ ] `npm test` covers `canReserve` and state transitions.
- [ ] No maintenance brain bypass; guardrails Patch Law documented in PR.

---

*Planning doc — update **Status** and phase checkboxes as work lands.*
