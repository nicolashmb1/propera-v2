# Propera Finance Roadmap

**Purpose:** Phased plan for Propera to own property finances — from the current operational cost slice to a full owner economics layer. Every phase is grounded in what the codebase ships today.

**Audience:** product, engineering, and the next agent picking up this work.

**Related (do not duplicate here):** [PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md](./PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md) (capabilities + Layer 0–5), [PROPERA_FINANCIAL_LAYER_MAP.md](./PROPERA_FINANCIAL_LAYER_MAP.md) (tables, routes, app proxy), **[FINANCIAL_INTAKE_V1.md](./FINANCIAL_INTAKE_V1.md)** — **design north** for the financial chat channel (V1 ticket cost → V2 four routes / LLM extract + brain validate → V3 queries/voice; **build capture before deepening dashboards**).

**North compass:** Money always traces to real operational events. Finance is **layered on top of operations** — not a parallel app. The deterministic core (resolver, lifecycle, policy) stays authoritative. Finance is **expression and posting** on top — never ownership, lifecycle, or routing logic.

**Strategic positioning (2026-05 — Leasehold / NJ incumbent):** For operators who already run **account-heavy** niche landlord accounting (e.g. **Leasehold**), Propera does **not** win by rebuilding that GL in v1. The moat is **operations + intelligence on top of accounting truth**: maintenance, communication, renewals, portfolio queries, and enrichment fields Propera owns. **Leasehold (or peer) stays system of record for rent posting and ledger math** until an explicit later gate. Propera **ingests read-only snapshots**, displays them in `/financial`, and **never writes back** in early phases. Payments and compliance posting stay in the incumbent; Propera is the **brain**, not a five-year accounting QA project.

---

## Incumbent ledger vs Propera-owned finance (align before building)

| Layer | Who owns it | Examples |
|-------|-------------|----------|
| **Accounting system of record** | Incumbent (Leasehold today) | Rent receipt, late fees, security deposit ledger, NJ-specific adjustments (MCI, grace), subsidy flags, official balance |
| **Snapshot inside Propera** | Import adapter → Postgres read models | Current rent (base + components), balance, last payment, lease dates, deposit on hand, ~12 months payment history — **`synced_at` stamped** |
| **Operational finance (Propera-native)** | Propera | Maintenance `ticket_cost_entries`, preventive costs, ticket-linked tenant charges, maintenance rollups |
| **Lease template / terms (Propera-native)** | Propera `unit_leases` + future structured riders | Expected rent, dates, deposit, recurring charge lines — **must not duplicate folklore** in free-text; escalators and riders are **fields**, not notes |
| **Enrichment (Propera-only)** | Propera | `renewal_escalator_cents`, market-rent estimate, late-payment risk, days-to-renewal — **computed or edited in Propera**; incumbent never sees these |
| **Intelligence & pipelines** | Propera (future) | Portfolio queries, renewal/late-payment pipelines, doc parse from lease PDF — **queries on snapshot + enrichment**, not on Leasehold UI |

**Minimum snapshot payload (per unit/tenancy)** — required before portfolio queries, delinquency views, or renewal pipelines are credible:

- Current rent (base + components: water, parking, fuel, MCI, etc. when available)
- Current balance and status (paid up / partial / behind)
- Last payment date and amount
- Lease start / end (and renewal window if known)
- Security deposit on hand
- Grace / late-fee policy dates (as structured fields when export provides them)
- ~12 months payment history (or rolling window)
- Subsidy / program flags if applicable

**Ingest paths (best → acceptable):** direct DB/read of incumbent files → scheduled rent-roll + ledger **CSV/Excel export** → parsed PDF reports → manual CSV upload bridge. Ask accounting: *“What is the cleanest recurring export of rent roll + tenant ledger?”*

**Phase 1 read rule:** `/financial` may show **imported snapshot balances** alongside Propera maintenance economics. **Do not** ask PMs to re-key Leasehold payments into `tenant_ledger_entries` as the primary path — manual ledger lines remain for **Propera-only adjustments** and ticket chargebacks, not duplicating the incumbent ledger.

---

## Finance inside Propera architecture (non-negotiable)

Propera is a **channel-agnostic property operation system** and **orchestrator**. SMS, WhatsApp, Telegram, and the portal are **ingress surfaces** — not the product boundary. Finance must respect the same shape as every other domain:

```
INBOUND (any channel)
→ Adapter (transport only — package in)
→ Signal / normalization
→ Brain (resolver + lifecycle + policy — decides truth)
→ Domain posting (operational + financial facts)
→ Outgate (expression — package out)
```

### What finance is (and is not)

| Finance **is** | Finance **is not** |
|----------------|-------------------|
| Owner economics layered on tickets, runs, units, properties | A second app or parallel “accounting brain” |
| Posting and rollups from **real operational events** | A place where PMs invent money without an event anchor |
| Read models + portal APIs + `/financial` cockpit lenses | Channel-specific payment logic in Telegram/SMS adapters |
| Optional **import adapters** (CSV, Stripe) that normalize → same tables | Ad-hoc spreadsheet logic in the UI |

### Package in — package out for money

| Direction | Shape | Examples today / planned |
|-----------|--------|-------------------------|
| **Package in** | External payment or cost reality → **normalized financial fact** → stored on canonical tables | Receipt upload on cost row; manual ledger POST; **Leasehold snapshot** via **`leasehold-bridge`** → `tenant_account_snapshots` (**Phase 1.5 shipped**); Phase 2 rent CSV / Stripe webhook → `rent_postings` when Propera becomes rent source |
| **Package out** | Closed period or rollup → **owner-facing expression** (PDF, email, portal card) | Phase 5 owner statement via outgate; portfolio KPI cards on `/financial` |

Adapters for rent imports or bank CSV **must not** assign responsibility, change ticket lifecycle, or bypass the signal layer. They only **ingest normalized financial packages** that the finance DAL posts.

### Top-level Financial module (`/financial`)

The **Financial module** is the **owner economics control plane** in propera-app — one module, multiple **lenses** on the same spine:

```
Portfolio (/financial)
  → Property (/financial/properties/[code])
    → Unit hub (/properties/.../units/[id] — lease + tenant ledger)
      → Ticket / preventive run (cost origin, drill-down)
```

| Lens (nav grows by phase) | Question it answers | Canonical data |
|---------------------------|---------------------|----------------|
| **Portfolio** | How is each property performing this month? | Rollups + lease sums + ledger aggregates |
| **Rent & balances** (Phase 2) | Expected vs collected vs delinquent? | `unit_leases` + `rent_postings` + `tenant_ledger_entries` |
| **Maintenance spend** | What did maintenance cost the owner? | `ticket_cost_entries` + `portal_property_maintenance_spend_month_v1` |
| **Chargebacks** | What did tenants reimburse? | Cost row tenant charges + ledger |
| **Vendors** (Phase 3) | What do we owe contractors? | `ticket_cost_entries` + `vendors` |
| **Statements** (Phase 5) | What did we send the owner? | `owner_statements` + PDF in storage |

**Connective engineering rule (Phase 1+):** add a small **financial read API** in propera-app (e.g. `GET /api/financial/portfolio`, `GET /api/financial/properties/[code]`) that assembles lease + ledger + maintenance in **one snapshot per property/month**. All `/financial` pages consume that — not scattered one-off fetches. Writes stay on existing paths (V2 portal for costs; Next routes for lease + manual ledger).

**UI split:** `/properties` = operational cockpit (work, people, units). `/financial` = money. Do not put portfolio KPIs back on the property grid.

### Connection graph (one spine)

```
ticket / program_run
  → ticket_cost_entries (spend + optional tenant charge)
    → tenant_ledger_entries (when charge approved + ledger flag, or manual)
unit_leases (expected rent / recurring charges)
  → rent_postings (Phase 2 — expected / collected / missed)
    → tenant_ledger_entries (payments)
portal rollups → /financial cards (owner truth)
```

Every phase below extends this graph — it does not fork a new money silo.

---

## Baseline — What ships today (migrations 042 → 052)

| Area | What exists |
|------|-------------|
| **Maintenance cost capture** | `ticket_cost_entries` (ticket or program-run parent) + V2 portal CRUD routes + propera-app ticket + preventive cost UI when finance flags on |
| **Tenant charge on cost row** | `tenant_charge_amount_cents` + `tenant_charge_status` on every cost row; approved rows auto-post to `tenant_ledger_entries` when `PROPERA_FINANCE_LEDGER_ENABLED=1` |
| **Maintenance rollups** | `portal_property_maintenance_spend_month_v1` (UTC month); `portal_properties_v1` with UTC-month + YTD spend/charge/count (migration 048) |
| **Vendor catalog** | `vendors` table + assignment to tickets + preventive program lines (migration 046) |
| **Owner `/financial` area** | Portfolio + property views use **Leasehold snapshots** when imported (**094**): billed, collected, collection rate, balance due, deposits, net rent enrichment; overview dashboard financial strip; `/financial/imports` for dev refresh; maintenance economics unchanged |
| **Unit lease snapshot** | `unit_leases` table (migration 049) — rent, deposit, lease dates, recurring charge billing modes; editable in propera-app |
| **Unit tenant ledger** | `tenant_ledger_entries` read + ticket-charge cross-check + **manual POST** (charge, fee, payment, credit, waiver, adjustment) from propera-app unit hub; manual lines support `effective_date` + `notes` (migration 052) |

**Flag map:**
- `PROPERA_FINANCE_ENABLED=1` — master
- `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1` — cost CRUD on tickets + runs
- `PROPERA_FINANCE_LEDGER_ENABLED=1` — auto-post approved ticket charges to tenant ledger
- `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1` — shows cost/finance surfaces in propera-app

---

## Phase 1 — Make the current slice credible and daily-usable
> **Goal:** Operators trust **Propera-native** maintenance economics and see **honest** rent/balance UX (snapshot or placeholder). Finish snapshot APIs and lease/ledger UX for units where Propera is already source of truth. **Do not** pretend Propera replaces Leasehold ledger yet.

### 1a — Maintenance cost view completeness

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| Rolling **12-month** trend per property | Sum monthly maintenance spend in-app for the last 12 UTC months ending at the selected month | propera-app computation (**shipped**) |
| **Cost category** breakdown in UI | Group `entry_type` (parts / labor / vendor_invoice / cleaning / permit / material / other) on `/financial/properties/[p]` maintenance tab | propera-app only (**shipped**) |
| **Ticket drill-down** from financial property view | Open maintenance-tab ticket rows in the shared `TicketDetailPanel` without leaving `/financial/properties/[p]` | propera-app only (**shipped**) |
| Receipts surfaced in financial views | Show `attachment_urls` preview/open affordances on cost rows in the spend table | propera-app only (**shipped**) |

### 1b — Unit lease template → actual rent roll

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Expected monthly income** per property | Sum `rent_cents` from `unit_leases` for all active units; show on `/financial` property card beside net owner cost | propera-app computation (**shipped**) |
| Lease **expiry alerts** | Flag units where `lease_end` is within 60 days on `/financial/properties/[p]` units table | propera-app (**shipped**) |
| **Vacant unit** revenue loss estimate | Month-scoped vacant days + estimated loss shown in unit row expand; uses canonical `unit_status_history` timing with unit rent when known, else property average rent | **Shipped** via migration **064** + propera-app snapshot math. Initial backfill for units already vacant at rollout is approximate (`updated_at` / `created_at` seed); transitions are exact going forward |

### 1c — Manual ledger UX hardening

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Void** a manual ledger line | `PATCH tenant_ledger_entries SET status = 'voided'` route + button in unit ledger UI | New propera-app route |
| **Date field** on manual entry | `effective_date date` column on `tenant_ledger_entries` (migration **052**) so PMs can back-date rent payments | Migration 052 + route update (**shipped in repo**) |
| **Per-entry notes** | `notes text` column on `tenant_ledger_entries` (same migration 052) | Migration 052 + UI field (**shipped in repo**) |
| Ledger **summary footer** on unit page | Charges total / payments total / net balance row at bottom of ledger table | propera-app only |
| **Financial snapshot API** | `GET /api/financial/properties/[code]?month=` — lease sums + ledger balance + maintenance rollup in one payload; unit rows now also expose deposit, selected-month posted payments, last payment, and 6-month payment history | propera-app only (**shipped**) |
| **Portfolio snapshot API** | `GET /api/financial/portfolio?month=` — drives property cards (replace ad-hoc per-page math) | propera-app only (**shipped**) |

### 1d — Property operating expenses (parallel-run operators)

> Added 2026-05-30. For operators running Propera **in parallel** with a legacy accounting system (e.g. Leasehold) before full migration. Not Phase 1.5 incumbent ingest — these are PM-entered lines for expenses Propera does not yet receive from the incumbent.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`property_expenses`** table | Property-level operating costs: tax, insurance, utilities, landscaping, staff/payroll allocation, management fee, permits, legal, etc. Not ticket-backed. Category enum (19 types), recurrence tag, vendor, amount, date, void support. | Migration **082** |
| **Expense entry UI** | Third tab ("Expenses") on `/financial/properties/[p]` — table with category, vendor, amount, date, recurrence. "+ Add Expense" opens modal. Void button on each row. | propera-app only |
| **Bill scan** | "Scan Bill" photo capture in the Add Expense modal — image proxied to V2 `POST /api/portal/scan-expense`, which calls OpenAI or Anthropic vision (provider/model via `PROPERA_EXPENSE_SCAN_PROVIDER` / `PROPERA_EXPENSE_SCAN_MODEL` in V2 env). Pre-fills modal fields from extracted vendor, amount, date, category. | propera-app proxy + V2 `src/brain/shared/expenseScanVision.js` |
| **Record Payment** (Phase 2 Option A early) | "Record Payment" button in the unit row expand panel on `/financial/properties/[p]`. Posts `entry_kind = 'payment'` to existing `tenant_ledger_entries` via existing ledger POST route. Amount, date, method, reference, notes. Updates "Payments this month" and standing balance immediately. | propera-app only — uses existing `POST /api/properties/[code]/units/[unitId]/ledger` |
| **Snapshot rollup** | `GET /api/financial/properties/[code]` includes `operatingExpenses`, `operatingExpensesMonthCents`, `operatingExpensesYtdCents`; portfolio totals sum month operating expenses | propera-app `financialSnapshot.ts` |

**Guardrail:** `property_expenses` rows are PM-entered operational facts — not a substitute for the incumbent accounting ledger. When Phase 1.5 snapshot ingest ships, the Expenses tab should clearly distinguish Propera-entered costs from imported accounting data.

**Phase 1 deliverable:** Maintenance spend and ticket chargebacks are trustworthy in-app. Per unit: lease **template** in `unit_leases` is editable; ledger shows Propera-posted lines + ticket charges; **if snapshot ingest exists**, balance/rent/collected come from snapshot with **as-of** label — not re-keyed from Leasehold.

---

## Phase 1.5 — Accounting state snapshot (incumbent read-only) — **shipped 2026-06-08**

> **Status:** **Live** for Leasehold via sibling **`leasehold-bridge`** (flat-file adapter). Propera never parses `H.Dat`; bridge exports normalized facts → propera-app import → Supabase. **Office syncher** (mirror → staging → changed-properties import) is **specified** — script + Task Scheduler **pending** at office PC.

> **Goal:** `/financial` portfolio and unit views show **real** rent collected, delinquent, and balance from the incumbent — refreshed on a schedule — without Propera becoming the rent ledger.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`tenant_account_snapshots`** | Per `unit_catalog_id`: balance, rent, payments, lease dates, `payload_json`, `source_system`, `synced_at` | Migration **094** (**shipped**) |
| **Net rent enrichment** | Standing credits / subsidized units → `unit_leases.net_rent_cents` | Migration **095** + `leaseEnrichmentImport.ts` |
| **Deposit enrichment** | Security + key deposits from S.Dat/R.Dat | Migration **096** + `depositEnrichmentImport.ts` |
| **Import adapter** | `POST /api/financial/import/accounting-snapshots`; dev helpers `run-leasehold`, `run-leasehold-all` | propera-app + `leaseholdBridgeExport.ts` |
| **Scheduled sync** | Office PC: robocopy mirror → staging, fingerprint, import changed properties only. **Mon–Sat 5 min, Sun 6 h.** Manual UI: `/financial/imports` | `../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md` |
| **Wire snapshot APIs** | `GET /api/financial/portfolio` and `.../properties/[code]` prefer snapshot; overview KPI strip on `/dashboard` | `financialSnapshot.ts` (**shipped**) |
| **Properties v1** | WESTGRAND, WESTFIELD, MURRAY, MORRIS, PENN | `leasehold-bridge/config/property-mapping.json` |

**Accounting “as of” display (locked UX):** `synced_at` is stored on every snapshot row (audit + idempotency) but shown **once per scope** in the UI — not on every unit row, metric card, or table cell.

| Scope | Show once | Do **not** repeat |
|-------|-----------|-------------------|
| **Property `/financial/properties/[code]`** | One quiet line in the header/subtitle: `Accounting · Leasehold · as of {date time}` next to the month picker or under the property title | Per-unit row, per-metric hint, CSV columns |
| **Portfolio `/financial`** | One portfolio-level line only when imported accounting numbers are in use: `Portfolio accounting · as of {latest sync across properties}` | Per property card, per KPI |
| **Unit hub** | Inherits property context — no extra stamp on the unit page | “As of” on balance/rent cells |

Stale sync: if `synced_at` is older than policy (e.g. 24h), tint the **single** header badge warn — still one line, not row noise.
| **Unit match key** | Map export rows → `unit_catalog_id` (property + unit label / external id column) | One-time mapping table or config |

**Phase 1.5 deliverable:** Portfolio cards show **real** rent collected and delinquent from Leasehold export; property financial view shows unit balances **read-only** with **one** property-level “as of” line. No write-back to Leasehold.

**Guardrail:** Snapshot rows are **immutable facts from import** except superseded by the next sync. Propera enrichment columns live on **`unit_leases`** or a sibling `unit_lease_enrichment` table — never mixed into snapshot payload as if Leasehold said so.

---

## Phase 2 — Rent roll + delinquency (portfolio truth in Propera)

> **Goal:** Fill `/financial` placeholders with **trusted numbers**. For Leasehold operators, **Phase 1.5 snapshot is the default path**. Phase 2 **Option B (import)** generalizes to any CSV. **Option A (manual posting)** is for greenfield portfolios with no incumbent — not the primary path when Leasehold is live.

### Option A — Manual rent posting (greenfield / no incumbent)
Operators post rent each month inside Propera. Use when there is **no** Leasehold (or export is impossible).

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`rent_postings`** table | `unit_catalog_id`, `period_month` (date, first of month), `amount_cents`, `status` (expected / collected / partial / missed), `posted_by`, timestamps | Migration 053 |
| Bulk **"Post this month's rent"** action | One click posts all active units' `rent_cents` from `unit_leases` as `expected`; PM then marks each collected or missed | propera-app `/financial` action |
| **Delinquency roll-up** | Sum `amount_cents` where `status IN ('missed', 'partial')` for current month; wire to the `/financial` portfolio card placeholders | propera-app computation on rollup view |
| **Collected vs expected** on property card | Replace "Rent collected — " placeholder with real numbers | propera-app |

### Option B — Import integration (incumbent export, Stripe, PMS CSV)
For operators who already collect rent in another tool. **Leasehold rent roll + ledger export maps here** (same adapter pattern as Phase 1.5; Phase 2 may promote snapshot → `rent_postings` for analytics).

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Import adapter** endpoint | Accept CSV (date, unit, amount, status) → batch upsert into `rent_postings` and/or refresh snapshots | propera-app or V2 route |
| **Leasehold / niche export profile** | Document column mapping for NJ rent roll (base rent, water, late fee date, MCI, subsidy) — versioned import spec | `docs/` + adapter code |
| **Stripe webhook** adapter | Stripe `payment_intent.succeeded` → normalize → post to `rent_postings` and `tenant_ledger_entries` | V2 adapter (when Propera is payment rail) |

### Phase 2 deliverable
The three headline numbers on every property card — **rent collected**, **delinquent**, **net owner cost (maintenance)** — are real, not dashes.

---

## Phase 3 — Vendor finance (what we owe vendors)
> **Goal:** Close the loop on the spending side. Propera already tracks who the vendor is and what the ticket cost. This phase makes vendor economics visible and actionable.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Invoice object** on cost row | `invoice_number text`, `invoice_date date`, `due_date date`, `paid_status enum(unpaid/paid/partial)` on `ticket_cost_entries` (already has `paid_status`) | Migration 054 — extend existing table |
| **Vendor balance view** | Sum unpaid `ticket_cost_entries` by `vendor_name` (or future `vendor_id`) → rolling AP aging | Supabase view |
| **Vendor finance tab** in propera-app | `/financial/vendors` — table: vendor name, open invoices count, total owed, oldest unpaid age | propera-app new route |
| **Mark paid** action | `PATCH ticket_cost_entries/:id { paid_status: "paid" }` already exists in DAL; wire a "Mark paid" button in the vendor view | propera-app + existing V2 route |
| Vendor master extensions | `terms_days int`, `tax_id text`, `insurance_expiry date` on `vendors` table (migration 055) — for portfolios with many vendors | Migration 055 |

**Phase 3 deliverable:** PM opens the vendor tab and sees exactly what is owed to each contractor this month, and can mark invoices paid.

---

## Phase 4 — Budget vs actual
> **Goal:** Owners can set a maintenance budget per property per year and see real vs budget as work happens.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`property_budgets`** table | `property_code`, `year int`, `category text nullable` (maps to `entry_type`), `budget_cents bigint`, timestamps | Migration 056 |
| Budget editor in `/financial` | Simple per-property form: total annual budget + optional split by category | propera-app |
| **Budget vs actual** column on property card | `actual YTD / budget × 100 %`; red when over | propera-app |
| Alert when approaching threshold | V2 scheduled job: query rollup vs budget; post notification when `actual > 80%` of budget | V2 jobs layer (`src/jobs/`) |

**Phase 4 deliverable:** Owners get one line per property — budgeted, spent, remaining — updated in real time as tickets and preventive costs come in.

---

## Phase 5 — Owner reporting and statements
> **Goal:** Propera generates the monthly owner statement automatically. This is the moment Propera fully replaces the Excel email the PM sends every month.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Owner statement model** | `owner_statements` table: property, period, income_cents (from rent_postings), maintenance_cost_cents (from rollup), net_cents, status (draft/sent), timestamps | Migration 057 |
| **Statement generator** | V2 scheduled job: pull rent roll + maintenance costs for closed month → insert `owner_statements` row | V2 jobs |
| **PDF renderer** | Jinja/Handlebars template rendered server-side or via a PDF service → stored in `pm-attachments` bucket | V2 or propera-app `/api/statements/[id]/pdf` |
| **Statement view** in propera-app | `/financial/statements` — list of past statements per property; download PDF; preview in-app | propera-app |
| **Email delivery** | V2 outgate: `owner_statement_ready` kind → send PDF link to owner email address | V2 outgate |
| **NOI calculation** | `income_cents − maintenance_cost_cents` per property per month — simple for now, expandable to full P&L when rent + vendor AP are complete | Model computation |

**Phase 5 deliverable:** Owner receives a PDF statement on the 1st of every month with: rent collected, maintenance spend (with receipt links), net, and tenant charge recoveries. Zero PM manual work.

---

## Beyond finance phases — intelligence layer (product north star, not yet phased)

These items come **after** structured snapshots + enrichment exist. They do **not** require Propera to replace Leasehold GL.

| Priority | Capability | Depends on |
|----------|------------|------------|
| 1 | **Structured lease model** — escalator, riders, components, deposit rules as fields (not notes) | `unit_leases` extensions + validation vs snapshot rent |
| 2 | **Query layer** — portfolio questions (“expiring Q3”, “below market”, “late fee if grace moves”) | Snapshots + enrichment + property/unit graph |
| 3 | **Pipeline views** — renewals 180/90/60/30, delinquency, vacancy (same pattern as maintenance lifecycle) | Dates from snapshot + Propera timers/outgate |
| 4 | **Predictive** — late-pay risk, non-renewal, rent vs market | History + enrichment |
| 5 | **Document intelligence** — lease PDF → structured terms | Adapter → `unit_leases` / enrichment |
| 6 | **Tenant-facing surface** — pay rent, view lease, maintenance (SMS inbound exists; close the loop) | Snapshot read + payment rail decision |
| 7 | **Accounting bridge** — read Leasehold; optional push to QBO later | Phase 1.5 ingest; **no write-back** until explicit product gate |

**Do not skip 1.5 to build 2–7.** Intelligence is queries on **current state**; state still lives in Leasehold until ingest proves stable.

---

## Phase 6 — Full books (long-term, optional)
> **Goal:** Propera replaces the accounting software for operators who do not need a CPA-grade GL. This is a deliberate product bet, not a default path — and **not** the strategy for Leasehold-first portfolios until Phases 1.5–5 prove value without displacing incumbent posting.

| Build | Notes |
|-------|-------|
| **Chart of accounts** | COA table + mapping rules from `entry_type` and `rent_postings` categories |
| **General ledger** | Double-entry rows derived from every financial event (rent posting, cost entry, manual ledger line) |
| **Bank reconciliation** | Import bank CSV → auto-match to rent postings + vendor payments |
| **Trust accounting** | Security deposit tracking per tenancy + required segregation rules by jurisdiction |
| **Tax exports** | 1099 vendor summaries, Schedule E income/expense by property |
| **Accountant portal** | Read-only role + export to QuickBooks / Xero CSV |

**Decision gate:** Start Phase 6 only when Phase 2 (rent roll) + Phase 3 (vendor AP) are in daily use and operators ask to replace their accounting tool. Otherwise Propera exports clean data to QuickBooks and stays in its lane.

---

## Migration sequence

| Migration | Content | Prerequisite | Status |
|-----------|---------|--------------|--------|
| 042 | `ticket_cost_entries`, `tenant_ledger_entries`, rollup views | core | applied |
| 046 | `vendors`, program line vendor columns | 042 | applied |
| 047 | Program-run cost entries | 042 | applied |
| 048 | `portal_properties_v1` YTD maintenance columns | 042 | applied |
| 049 | **`unit_leases`** | 030 (units catalog) | applied |
| 050 | Ledger unit+property index | 042 | applied |
| **051** | `assigned_staff_id` + `assigned_staff_display` on `program_lines` (preventive ops — not finance tables) | 046 | applied |
| **052** | `effective_date` + `notes` on `tenant_ledger_entries` | 042 | applied |
| **082** | **`property_expenses`** — PM-entered operating costs (tax, insurance, utilities, staff allocation, management fee, etc.) not tied to tickets. Phase 1d for parallel-run operators. Writes via propera-app route + auth gate; bill scan via V2. | 042, properties | applied |
| **058** | **`tenant_account_snapshots`** + payment history (incumbent read-only ingest) | 049, 030 | **deferred** — design after Leasehold export spec |
| **053** | **`rent_postings`** | 049 | planned (Phase 2 — greenfield or promoted from snapshot) |
| **054** | Invoice fields on `ticket_cost_entries` | 042 | planned (Phase 3) |
| **055** | Vendor master extensions | 046 | planned (Phase 3) |
| **056** | **`property_budgets`** | 042 | planned (Phase 4) |
| **057** | **`owner_statements`** | 053 + 042 | planned (Phase 5) |

**051 is not a finance migration** — do not repurpose it for ledger columns. Finance ledger hardening starts at **052**.

**Current caution:** before writing the next Phase 2 finance migration, confirm the numbering sequence. `053_financial_intake_cost_capture.sql` already exists in-repo, so the old "`053 = rent_postings`" placeholder needs re-sequencing before implementation.

---

## Feature flag additions needed

| Flag | Phase | Purpose |
|------|-------|---------|
| `NEXT_PUBLIC_FINANCE_RENT_ENABLED` | 2 | Show rent roll / delinquency surfaces |
| `NEXT_PUBLIC_FINANCE_VENDOR_AP_ENABLED` | 3 | Show vendor finance tab |
| `NEXT_PUBLIC_FINANCE_BUDGETS_ENABLED` | 4 | Show budget vs actual |
| `PROPERA_STATEMENTS_ENABLED` | 5 | Enable statement generator + PDF job |

Each phase is independently toggleable. Operators not ready for Phase 3 never see the vendor AP tab.

---

## What never changes (guardrails)

### Architecture (same as core Propera)

1. **Channel-agnostic.** Rent imports, Stripe, bank CSV, and portal cost entry all normalize into the **same canonical tables** — never channel-specific finance tables or adapter-side business rules.
2. **Package in — package out.** Inbound money facts arrive as normalized packages (adapter → DAL post). Outbound owner truth is generated expression (rollup views, statements, outgate) — not recomputed in SMS/Telegram handlers.
3. **Orchestrator owns operations; finance posts on top.** Resolver, lifecycle, and policy decide **who acts next** on work. Finance never changes ticket stage, assignment, or responsibility — only cost rows, ledger lines, rent postings, and rollups.
4. **No finance logic in adapters.** Telegram/Twilio/portal webhooks do not compute balances or post ledger lines except through defined portal/finance routes.

### Finance implementation

5. **Browser never writes `ticket_cost_entries` directly.** V2 portal routes with finance flags are the only writers.
6. **Ticket economics stay authoritative on tickets.** Manual ledger lines are PM/owner adjustments, not substitutes for the ticket-cost path.
7. **Each phase ships schema + portal/API + propera-app surface (+ snapshot read API when portfolio-facing).** No orphaned half-done migrations.
8. **Placeholders are honest.** If data is not yet connected, the UI says so explicitly rather than showing zero.
9. **`/financial` reads go through snapshot/rollup APIs** once Phase 1 snapshot work lands — avoid duplicating rollup math in every page component.

---

## Measuring progress

| Phase | Metric that proves it is done |
|-------|-------------------------------|
| 1 | % of maintenance spend captured in-system with a receipt or note, visible on a property view without spreadsheet |
| 1.5 | Portfolio rent collected / delinquent / unit balance match Leasehold export within sync window; **as-of** visible; zero write-back |
| 2 | Rent collected / delinquent numbers on `/financial` portfolio cards are real for all properties (snapshot **or** native `rent_postings`) |
| 3 | PM can see total owed to each vendor this month and mark invoices paid without leaving Propera |
| 4 | Owners see budget vs actual % on every property, updated same day as ticket costs are added |
| 5 | Monthly owner statement generated and delivered automatically with zero PM manual work |
| 6 | Operator replaces their accounting tool with Propera for a production portfolio |

---

*Created: 2026-05-19. Updated: 2026-06-08 — Phase 1.5 **shipped** (094–096, leasehold-bridge, import APIs, portfolio rollups, overview KPIs). Office syncher script pending. When a phase item changes, note in HANDOFF_LOG.md and update PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md §2.5a + §8.*
