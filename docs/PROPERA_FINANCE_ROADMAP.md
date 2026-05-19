# Propera Finance Roadmap

**Purpose:** Phased plan for Propera to own property finances — from the current operational cost slice to a full owner economics layer. Every phase is grounded in what the codebase ships today.

**Audience:** product, engineering, and the next agent picking up this work.

**North compass:** Money always traces to real operational events. Finance is **layered on top of operations** — not a parallel app. The deterministic core (resolver, lifecycle, lifecycle) stays authoritative. Finance is expression and posting on top.

---

## Baseline — What ships today (migrations 042 → 050)

| Area | What exists |
|------|-------------|
| **Maintenance cost capture** | `ticket_cost_entries` (ticket or program-run parent) + V2 portal CRUD routes + propera-app ticket + preventive cost UI when finance flags on |
| **Tenant charge on cost row** | `tenant_charge_amount_cents` + `tenant_charge_status` on every cost row; approved rows auto-post to `tenant_ledger_entries` when `PROPERA_FINANCE_LEDGER_ENABLED=1` |
| **Maintenance rollups** | `portal_property_maintenance_spend_month_v1` (UTC month); `portal_properties_v1` with UTC-month + YTD spend/charge/count (migration 048) |
| **Vendor catalog** | `vendors` table + assignment to tickets + preventive program lines (migration 046) |
| **Owner `/financial` area** | Portfolio page with property cards (maintenance net owner cost live; rent/delinquency **explicit placeholders**); `/financial/properties/[p]` with units table + maintenance tab |
| **Unit lease snapshot** | `unit_leases` table (migration 049) — rent, deposit, lease dates, recurring charge billing modes; editable in propera-app |
| **Unit tenant ledger** | `tenant_ledger_entries` read + ticket-charge cross-check + **manual POST** (charge, fee, payment, credit, waiver, adjustment) from propera-app unit hub |

**Flag map:**
- `PROPERA_FINANCE_ENABLED=1` — master
- `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1` — cost CRUD on tickets + runs
- `PROPERA_FINANCE_LEDGER_ENABLED=1` — auto-post approved ticket charges to tenant ledger
- `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1` — shows cost/finance surfaces in propera-app

---

## Phase 1 — Make the current slice credible and daily-usable
> **Goal:** Operators trust the numbers and use them without exporting to Excel. Rent is acknowledged as a future connection, not a missing field nobody knows about. No new major tables needed.

### 1a — Maintenance cost view completeness

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| Rolling **12-month** trend per property | Sum `portal_property_maintenance_spend_month_v1` 12 rows in-app (no new table) | propera-app computation |
| **Cost category** breakdown in UI | Group `entry_type` (parts / labor / vendor_invoice / cleaning / permit / material / other) into a small bar chart on `/financial/properties/[p]` maintenance tab | propera-app only |
| **Ticket drill-down** from financial property view | Link from maintenance tab row → ticket detail panel (same `TicketDetailPanel`) | propera-app only |
| Receipts surfaced in financial views | Show `attachment_urls` count badge on cost rows in spend table | propera-app only |

### 1b — Unit lease template → actual rent roll

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Expected monthly income** per property | Sum `rent_cents` from `unit_leases` for all active units; show on `/financial` property card beside net owner cost | Supabase view or propera-app computation |
| Lease **expiry alerts** | Flag units where `lease_end` is within 60 days on `/financial/properties/[p]` units table | propera-app |
| **Vacant unit** revenue loss estimate | `days_vacant × (average rent_cents for property)` shown in unit row expand — uses existing `unit_leases` data | propera-app |

### 1c — Manual ledger UX hardening

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Void** a manual ledger line | `PATCH tenant_ledger_entries SET status = 'voided'` route + button in unit ledger UI | New propera-app route |
| **Date field** on manual entry | `effective_date date` column on `tenant_ledger_entries` (migration 051) so PMs can back-date rent payments | Migration 051 + route update |
| **Per-entry notes** | `notes text` column on `tenant_ledger_entries` (same migration 051) | Migration 051 + UI field |
| Ledger **summary footer** on unit page | Charges total / payments total / net balance row at bottom of ledger table | propera-app only |

**Phase 1 deliverable:** An operator can open any unit, see the lease terms, see every charge and payment ever posted (manually or from tickets), see the running balance, and act on it — all without a spreadsheet.

---

## Phase 2 — Rent roll + delinquency (the two missing numbers)
> **Goal:** Fill the explicit placeholders on the `/financial` portfolio page. Propera should know how much rent is expected, how much was collected, and who is behind — without requiring AppFolio or Yardi.

### Option A — Manual rent posting (no integration required)
Operators post rent each month themselves. Low tech, high control.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`rent_postings`** table | `unit_catalog_id`, `period_month` (date, first of month), `amount_cents`, `status` (expected / collected / partial / missed), `posted_by`, timestamps | Migration 052 |
| Bulk **"Post this month's rent"** action | One click posts all active units' `rent_cents` from `unit_leases` as `expected`; PM then marks each collected or missed | propera-app `/financial` action |
| **Delinquency roll-up** | Sum `amount_cents` where `status IN ('missed', 'partial')` for current month; wire to the `/financial` portfolio card placeholders | propera-app computation on rollup view |
| **Collected vs expected** on property card | Replace "Rent collected — " placeholder with real numbers | propera-app |

### Option B — Import integration (Stripe, Buildium CSV, AppFolio CSV)
For operators who already collect rent in another tool.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Import adapter** endpoint | Accept CSV (date, unit, amount, status) → batch upsert into `rent_postings` | New propera-app or V2 route |
| **Stripe webhook** adapter | Stripe `payment_intent.succeeded` → normalize → post to `rent_postings` and `tenant_ledger_entries` | V2 adapter (channel shape already exists) |

### Phase 2 deliverable
The three headline numbers on every property card — **rent collected**, **delinquent**, **net owner cost (maintenance)** — are real, not dashes.

---

## Phase 3 — Vendor finance (what we owe vendors)
> **Goal:** Close the loop on the spending side. Propera already tracks who the vendor is and what the ticket cost. This phase makes vendor economics visible and actionable.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Invoice object** on cost row | `invoice_number text`, `invoice_date date`, `due_date date`, `paid_status enum(unpaid/paid/partial)` on `ticket_cost_entries` (already has `paid_status`) | Migration 053 — extend existing table |
| **Vendor balance view** | Sum unpaid `ticket_cost_entries` by `vendor_name` (or future `vendor_id`) → rolling AP aging | Supabase view |
| **Vendor finance tab** in propera-app | `/financial/vendors` — table: vendor name, open invoices count, total owed, oldest unpaid age | propera-app new route |
| **Mark paid** action | `PATCH ticket_cost_entries/:id { paid_status: "paid" }` already exists in DAL; wire a "Mark paid" button in the vendor view | propera-app + existing V2 route |
| Vendor master extensions | `terms_days int`, `tax_id text`, `insurance_expiry date` on `vendors` table (migration 054) — for portfolios with many vendors | Migration 054 |

**Phase 3 deliverable:** PM opens the vendor tab and sees exactly what is owed to each contractor this month, and can mark invoices paid.

---

## Phase 4 — Budget vs actual
> **Goal:** Owners can set a maintenance budget per property per year and see real vs budget as work happens.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **`property_budgets`** table | `property_code`, `year int`, `category text nullable` (maps to `entry_type`), `budget_cents bigint`, timestamps | Migration 055 |
| Budget editor in `/financial` | Simple per-property form: total annual budget + optional split by category | propera-app |
| **Budget vs actual** column on property card | `actual YTD / budget × 100 %`; red when over | propera-app |
| Alert when approaching threshold | V2 scheduled job: query rollup vs budget; post notification when `actual > 80%` of budget | V2 jobs layer (`src/jobs/`) |

**Phase 4 deliverable:** Owners get one line per property — budgeted, spent, remaining — updated in real time as tickets and preventive costs come in.

---

## Phase 5 — Owner reporting and statements
> **Goal:** Propera generates the monthly owner statement automatically. This is the moment Propera fully replaces the Excel email the PM sends every month.

| Build | Detail | Migrations / code |
|-------|--------|-------------------|
| **Owner statement model** | `owner_statements` table: property, period, income_cents (from rent_postings), maintenance_cost_cents (from rollup), net_cents, status (draft/sent), timestamps | Migration 056 |
| **Statement generator** | V2 scheduled job: pull rent roll + maintenance costs for closed month → insert `owner_statements` row | V2 jobs |
| **PDF renderer** | Jinja/Handlebars template rendered server-side or via a PDF service → stored in `pm-attachments` bucket | V2 or propera-app `/api/statements/[id]/pdf` |
| **Statement view** in propera-app | `/financial/statements` — list of past statements per property; download PDF; preview in-app | propera-app |
| **Email delivery** | V2 outgate: `owner_statement_ready` kind → send PDF link to owner email address | V2 outgate |
| **NOI calculation** | `income_cents − maintenance_cost_cents` per property per month — simple for now, expandable to full P&L when rent + vendor AP are complete | Model computation |

**Phase 5 deliverable:** Owner receives a PDF statement on the 1st of every month with: rent collected, maintenance spend (with receipt links), net, and tenant charge recoveries. Zero PM manual work.

---

## Phase 6 — Full books (long-term, optional)
> **Goal:** Propera replaces the accounting software for operators who do not need a CPA-grade GL. This is a deliberate product bet, not a default path.

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

| Migration | Content | Prerequisite |
|-----------|---------|-------------|
| 042 | `ticket_cost_entries`, `tenant_ledger_entries`, rollup views | core |
| 046 | `vendors`, program line vendor columns | 042 |
| 047 | Program-run cost entries | 042 |
| 048 | `portal_properties_v1` YTD maintenance columns | 042 |
| 049 | **`unit_leases`** | 030 (units catalog) |
| 050 | Ledger unit+property index | 042 |
| **051** | `effective_date` + `notes` on `tenant_ledger_entries` | 042 |
| **052** | **`rent_postings`** | 049 |
| **053** | Invoice fields on `ticket_cost_entries` | 042 |
| **054** | Vendor master extensions | 046 |
| **055** | **`property_budgets`** | 042 |
| **056** | **`owner_statements`** | 052 + 042 |

Bold = not yet applied.

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

1. **Browser never writes `ticket_cost_entries` directly.** V2 portal routes with finance flags are the only writers.
2. **Ticket economics stay authoritative on tickets.** Manual ledger lines are PM/owner adjustments, not substitutes for the ticket-cost path.
3. **The resolver and lifecycle stay the operating layer.** Finance is always expression and posting on top — not control logic.
4. **Each phase ships schema + portal/API + propera-app surface.** No half-done phases left as orphaned schema.
5. **Placeholders are honest.** If data is not yet connected, the UI says so explicitly rather than showing zero.

---

## Measuring progress

| Phase | Metric that proves it is done |
|-------|-------------------------------|
| 1 | % of maintenance spend captured in-system with a receipt or note, visible on a property view without spreadsheet |
| 2 | Rent collected / delinquent numbers on `/financial` portfolio cards are real for all properties |
| 3 | PM can see total owed to each vendor this month and mark invoices paid without leaving Propera |
| 4 | Owners see budget vs actual % on every property, updated same day as ticket costs are added |
| 5 | Monthly owner statement generated and delivered automatically with zero PM manual work |
| 6 | Operator replaces their accounting tool with Propera for a production portfolio |

---

*Created: 2026-05-19. Update §Baseline and migration table when new migrations land. When a phase completes, move it to HANDOFF_LOG.md and update PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md §8.*
