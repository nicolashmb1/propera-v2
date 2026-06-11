# Staff Actions & Documents Library

**Status:** Planning — blocked on sample eviction PDF / field list from operations.

**Purpose:** One-click staff actions (e.g. **File for eviction**) that fill configured documents and send via configured delivery — today **button-driven**, later **policy-driven** using the same executor. Behavior is configurable in Settings without redeploying for lawyer email, templates, CC, etc.

**Audience:** product, engineering, next agent picking up this work.

**Related:**

- [OPERATIONAL_POLICY_CONFIG.md](./OPERATIONAL_POLICY_CONFIG.md) — *when* actions auto-run (thresholds, timers)
- [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) — delinquency pipeline, finance context
- [CONFLICT_MEDIATION_ENGINE.md](./CONFLICT_MEDIATION_ENGINE.md) — explicitly **out of scope** for eviction/court filing
- Balance reminders (`balance_reminder_*`) — separate cron automation today; optional future convergence

**North compass:** Staff portal click → normalized request → **deterministic domain engine** (Staff Action Engine) → fill document + send → audit. No AI inventing legal facts. Not SMS brain router. Not CME.

---

## Problem (office flow today)

1. Boss tells secretary: file apt X for eviction.
2. Staff manually fills a form from Leasehold / notes / lease file.
3. Staff emails the form to the lawyer.

**Target:** One button → system loads tenant/unit context → fills configured document → sends to configured recipient → immutable audit record.

---

## Three layers (do not merge)

```text
┌─────────────────────────────────────────────────────────────┐
│  POLICIES (existing /settings/policies)                     │
│  When may an action run automatically?                      │
│  e.g. finance.eviction_auto_refer_after_days = 90           │
└──────────────────────────┬──────────────────────────────────┘
                           │ future: cron / delinquency rule
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  ACTIONS (/settings/actions — new)                          │
│  Recipe: which doc + how to send + to whom + who may click  │
│  e.g. file_eviction → Eviction doc → email lawyer           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DOCUMENTS (/settings/documents — new)                      │
│  Reusable templates + field bindings                        │
│  e.g. Eviction PDF, Rent invoice, Lease renewal letter      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
              executeStaffAction()  →  staff_action_runs audit
```

| Layer | What it is | Settings surface |
|-------|------------|------------------|
| **Documents** | Assets: PDF/HTML templates + placeholder → data path map | **Documents** |
| **Actions** | Executable recipe per staff action type | **Action configuration** |
| **Policies** | Timing / thresholds for auto-trigger | **Policies** (existing) |

**Do not** put document files on the Policies page. Policies are rules (numbers, bools, enums). Documents are assets. Actions are recipes.

---

## Settings UI (proposed)

Add to Settings nav:

1. **Documents** — central library
2. **Actions** — action configuration tab

Keep **Policies** as-is for automation timing.

### Documents library

Templates used broadly across the system:

| Example doc | Category |
|-------------|----------|
| Eviction filing packet | Legal |
| Rent invoice | Billing |
| Lease renewal letter | Lease |
| *(later)* Demand letter, 5-day notice, owner statement attachment | Legal / Billing |

Per document:

- Upload PDF (AcroForm preferred for v1) or HTML template later
- Name, category, description
- **Field bindings:** template field → data path (`tenant.name`, `unit.label`, `finance.balance_dollars`, …)
- Preview with sample unit (like Organization SMS preview)

### Action configuration

One configurable row per registered action type. First action: **`file_eviction`**.

| Setting | Purpose |
|---------|---------|
| Enabled | On/off |
| Label | Button text in UI |
| Document | Pick from Documents library |
| Delivery channel | Email (v1); later SMS, portal doc, download-only |
| **To** | Static recipient email(s) — e.g. lawyer |
| **CC** | Boss, PM, etc. |
| **From / sender** | Org outbound identity (see Email section) |
| Subject template | Placeholders |
| Cover email body | Placeholders |
| Who can run | Role gate (office staff / PM / owner) |
| Surfaces | Where button appears: `delinquency`, `unit_finance`, … |
| Preflight (optional v1) | Min balance, min days delinquent — warn or block |

Staff does not reconfigure at click time unless required fields are missing (short confirm sheet).

---

## Runtime flow (button today)

```text
Staff clicks "File for eviction" (delinquency row or unit hub)
  → POST /api/portal/staff-actions/file_eviction/execute { unitId }
  → load action config for org
  → assemble context packet (tenant, unit, property, lease, balance, org)
  → preflight (action config + optional policy)
  → fill document from library
  → send email (attach filled PDF)
  → insert staff_action_runs (actor, timestamps, storage path, message id)
  → return success + case/run id
```

Future (policy-driven):

```text
Cron / delinquency evaluator sees unit matches policy
  → same executeStaffAction('file_eviction', unitId)
  → no button click
```

---

## Context packet (auto-fill sources)

Data already in Propera or cheap to add:

| Typical form field | Source |
|--------------------|--------|
| Property / building address | `properties.address` |
| Unit / apartment | `units` + unit label |
| Tenant name(s) | `tenant_roster` / `tenant_account_snapshots` |
| Monthly rent | `unit_leases` / snapshot |
| Balance owed | snapshot / `tenant_ledger_entries` |
| Lease start / end | `unit_leases` |
| Last payment date / amount | snapshot / ledger |
| Management company | `organizations.brand_name` |
| Filing date | generated at send time |
| Requested by | portal staff user |

**Likely gaps** (settings or confirm at send):

- Tenant **mailing** address (if ≠ unit)
- **Plaintiff legal entity** (LLC per building) — org or property setting
- Court / county / index number (lawyer may fill — confirm with ops)
- **Prior notice dates** (demand, 5-day, etc.)

---

## Email: sender and recipient

**Recipient:** from action config (`counsel@lawfirm.com`). Optional future: property-level override.

**Sender options:**

| Option | Notes |
|--------|-------|
| Dedicated org mailbox (`legal@pm.com`) | Recommended — needs Resend/SendGrid + domain verify |
| Staff user email | Simple but weak audit / personal inbox |
| From org, Reply-To staff who clicked | Good for lawyer replies |

**Recommendation v1:** From = org legal/outbound address, Reply-To = clicking staff, CC = configurable list.

Propera today has **Twilio SMS** for tenants, not staff-to-counsel email. This feature needs a **new email adapter** (staff/counsel channel), separate from tenant outgate.

---

## Architecture (V2 module)

**Module:** Staff Action Engine — portal-only DAL + routes in `propera-v2`, UI in `propera-app` Settings + action buttons on surfaces.

**Not:** brain inbound router, CME, maintenance lifecycle, court e-filing API, AI-drafted legal language, automatic tenant SMS about eviction.

### Suggested tables (sketch)

```sql
-- Document templates (org-scoped)
document_templates (
  id, org_id, template_key, name, category,
  storage_bucket, storage_path,
  mime_type,  -- application/pdf
  field_bindings jsonb,  -- { "TenantName": "tenant.displayName", ... }
  active, created_at, updated_at
)

-- Action recipes (org-scoped config instances)
staff_action_configs (
  id, org_id, action_key,  -- e.g. file_eviction
  enabled, label,
  document_template_id,
  delivery_channel,  -- email
  recipient_emails jsonb,
  cc_emails jsonb,
  sender_profile,  -- org outbound identity key
  subject_template text,
  body_template text,
  allowed_roles jsonb,
  surfaces jsonb,  -- ["delinquency", "unit_finance"]
  preflight jsonb,  -- { minBalanceCents, minDaysDelinquent }
  updated_at
)

-- Audit trail (every execution)
staff_action_runs (
  id, org_id, action_key, unit_catalog_id,
  property_code, unit_label,
  triggered_by,  -- staff_user_id | policy:cron
  triggered_by_email,
  balance_cents_at_run,
  document_template_id,
  output_storage_path,
  delivery_status, recipient_snapshot,
  external_message_id,  -- email provider id
  error text,
  ran_at
)
```

Org-level email identity may extend `organizations` or a small `org_email_profiles` table.

### API (sketch)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/portal/settings/documents` | List templates |
| POST | `/api/portal/settings/documents` | Upload + register |
| PATCH | `/api/portal/settings/documents/:id` | Field bindings, active |
| POST | `/api/portal/settings/documents/:id/preview` | Preview with unitId |
| GET | `/api/portal/settings/staff-actions` | List action configs |
| PATCH | `/api/portal/settings/staff-actions/:actionKey` | Update recipe |
| GET | `/api/portal/staff-actions?surface=delinquency` | Actions available on a UI surface |
| POST | `/api/portal/staff-actions/:actionKey/execute` | Run action for unitId |

App proxies mirror existing `/api/settings/*` pattern.

### UI surfaces (v1 button placement)

1. **Financial → Delinquency** — row action (especially 90+ / severe)
2. **Unit hub** — when balance delinquent

Generic **ActionButton** component: loads actions for surface from config, no hardcoded per-action pages.

---

## Future action examples (same rail)

| action_key | Document | Delivery |
|------------|----------|----------|
| `file_eviction` | Eviction doc | Email lawyer |
| `send_rent_invoice` | Rent invoice | Email tenant |
| `send_lease_renewal` | Renewal letter | Email tenant + portal doc |

---

## Policy keys (future — Policies page)

Register in policy catalog when auto-trigger is built:

| Key | Type | Example |
|-----|------|---------|
| `finance.eviction_auto_refer_enabled` | BOOL | false |
| `finance.eviction_auto_refer_days_delinquent` | NUMBER | 90 |
| `finance.eviction_auto_refer_min_balance_cents` | NUMBER | 100 |

Evaluator calls same `executeStaffAction('file_eviction', unitId)` as the button.

Delinquency pipeline stage (phase 2): mark unit `REFERRED_TO_COUNSEL` after successful run; block double-send unless explicit resend.

---

## “Without code” — honest scope

**Configurable without redeploy (v1):**

- Lawyer email, CC, subject/body templates
- Which document template
- Enabled flag, role gate, preflight thresholds
- Upload/replace PDF and field bindings in Settings

**Requires code once per new action type:**

- Register `action_key` in catalog
- Define required context fields + executor hook
- Wire button surface tags

Same pattern as `POLICY_CATALOG` in `portalOrgPolicies.js`: keys/schemas in code, values in Settings.

---

## Phased delivery

### Phase 0 — Discovery (**current blocker**)

Obtain from operations:

1. **Actual form** they send today (PDF/Word) or NJ form name
2. **Field list** — required vs lawyer-filled
3. **Lawyer workflow** — one inbox for all buildings? Cover email text? Extra attachments (ledger, lease copy)?

### Phase 1 — MVP (one-button win)

- Settings: Documents + Actions (`file_eviction`)
- Org sender profile + lawyer recipient
- Auto-fill + PDF + email + audit row
- Button on delinquency + unit hub

### Phase 2 — Pipeline & history

- Delinquency column: eviction status (none / referred / filed / closed)
- Download PDF from unit hub / run history
- Block duplicate send unless “Resend to lawyer”

### Phase 3 — Policy auto-trigger & preconditions

- Policy keys → cron/delinquency evaluator
- Require prior notices logged
- Optional property-level lawyer override

---

## Open decisions (fill in when doc arrives)

- [ ] Sample eviction PDF attached / field list documented
- [ ] Lawyer email: portfolio-wide vs per property/LLC
- [ ] Sender: existing mailbox vs new Resend domain
- [ ] Required before file: 90+ days? demand letter sent?
- [ ] Attachments: form only vs ledger summary + lease PDF
- [ ] Plaintiff legal name: org default vs per-property

---

## Build order (when unblocked)

1. Schema + Documents settings (upload, bindings, preview)
2. Actions settings (`file_eviction` first row)
3. Executor + email adapter + `staff_action_runs`
4. Button on delinquency + unit hub
5. Policy keys for auto-refer

---

## Changelog

| Date | Note |
|------|------|
| 2026-06-10 | Initial planning doc — button now, policy later; Documents + Actions settings split; blocked on eviction form from ops. |
