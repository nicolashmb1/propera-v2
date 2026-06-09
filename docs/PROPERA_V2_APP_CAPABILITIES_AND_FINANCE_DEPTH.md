# Propera V2 + propera-app — capabilities, integration, market context, finance depth

**Audience:** operators, product, and engineering deciding how “deep” finance and integrations should go.  
**Scope:** Honest snapshot of **what ships today** in **propera-v2** (Node + Supabase + orchestration) and how **propera-app** (Next.js) sits in front of it — plus a **layered finance roadmap** (your Layer 0–5) mapped to gaps.

### North star (product intent)

**Propera is a property operation system** — one place to run **the building**: work, people, policy, preventive programs, and (layered on top) the **economics** of that work (cost, charge, vendor, budget, owner truth). The goal is to **own the operation accountably and smartly**: deterministic ownership (“who acts next?”), auditability, and spend/charge that ties back to real events — not a loose collection of messages.

**SMS, WhatsApp, and Telegram are ingress surfaces**, not the definition of the product. They are where tenants and staff already are; the **system of record** and lifecycle still live in Postgres, portal APIs, and the cockpit UI. If copy or architecture ever frames Propera as “an SMS ticket app,” that drifts from first intent — correct it back to **property operations**.

**Related:** [BRAIN_PORT_MAP.md](./BRAIN_PORT_MAP.md) (inbound vs portal), [PROPERA_FINANCIAL_LAYER_MAP.md](./PROPERA_FINANCIAL_LAYER_MAP.md) (costs + ledger wiring), [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) (phased finance build plan), [PARITY_LEDGER.md](./PARITY_LEDGER.md) (GAS ↔ V2 truth), [PM_PROGRAM_ENGINE_V1.md](./PM_PROGRAM_ENGINE_V1.md) (preventive), [HANDOFF_LOG.md](./HANDOFF_LOG.md) (recent deltas).

---

## 1. What propera-v2 is (today)

**propera-v2** is the **engine** for that property operation system: a **Node/Express** service backed by **Supabase (Postgres)**. It combines:

| Pillar | Role |
|--------|------|
| **Property operations core** | Tickets, work items, lifecycle, policy, roster, properties, locations, timeline, attachments — the accountable graph of **what is happening at the asset** and **who owns the next action**. |
| **Channels (not the product boundary)** | Telegram / Twilio / portal commands feed **`runInboundPipeline`** → same core gates and maintenance brain; **outgate** is the single place for user-facing sends. Optional LLM/media enrichers sit **behind flags**, never replacing ownership rules. |
| **Programs & field ops** | Preventive / program runs, lines, expansion, proof, vendor-on-line — **PM_PROGRAM_ENGINE_V1**. |
| **Operational finance (when enabled)** | Cost rows, rollups, optional tenant ledger posting — **layers on the same tickets/runs**, not a disconnected ledger toy. |
| **Portal API** | Token-gated REST under `/api/portal/*` for **propera-app** (and similar clients): tickets, properties, tenants, program engine, PM mutations, finance endpoints when enabled. |
| **Webhooks** | `/webhooks/telegram`, `/webhooks/twilio`, `/webhooks/portal` (portal command bar / PM actions routed into the same brain contracts where applicable). |

**Non-goals (today):** replacing Yardi/AppFolio GL, full AP automation, bank reconciliation, corporate consolidated reporting, or native mobile apps. Those are product extensions, not implied by the current codebase.

---

## 2. Capabilities today (checklist)

### 2.1 Inbound & routing

- Multi-channel ingest (**Telegram**, **SMS/WhatsApp via Twilio**) with shared **router / lane** decisions.
- Staff capture, tenant maintenance flows, schedule parsing and policy gates (ported GAS semantics where wired — see **PARITY_LEDGER** for gaps).
- **Outgate** as the single place for user-facing sends (`dispatchOutbound`).
- Env-driven toggles: intake compile turn, LLM extract, media OCR/vision/audio, etc. (`src/config/env.js`).

### 2.2 Tickets & work

- Postgres-backed tickets + work items; portal read models (`portal_tickets_v1`, etc.).
- PM mutations: create/update/complete/delete, attachments, assignment (**staff** or **catalog vendor** when migrations + DAL are applied).
- Timeline / audit fields (see **TICKET_TIMELINE**, mutation audit migrations).

### 2.3 Owner / staff UI transport — **propera-app**

- **propera-app** is the **Next.js cockpit** for property operations: tickets, properties, tenants, preventive runs, optional turnover/meter surfaces when configured — the **staff/owner control plane**, not “the inbox.” It includes an **owner-first `/financial`** area (portfolio + maintenance spend + per-property units view) when the remote backend and flags support it.
- It **does not** talk to Supabase from the browser for finance or ticket writes; it calls **Next `/api/*` routes** that proxy to **V2** with **`X-Propera-Portal-Token`** (`propera-app`: `PROPERA_PORTAL_TOKEN` / align with V2 `PROPERA_PORTAL_TOKEN` or `PORTAL_API_TOKEN_PM` — see **SUPABASE_AND_GITHUB** / `.env.example` in each repo).
- **Unit lease** (`unit_leases`, migration **049**) and **unit ledger** (`tenant_ledger_entries` read + **manual** insert) use **Next server routes + Supabase service client** — not the V2 Express `ticketCostEntries` path; ticket cost rows remain **V2-only** as above.
- **GAS** may still serve legacy reads/writes where cutover is incomplete; merge behavior is documented in **PARITY_LEDGER** / tickets API implementation.

### 2.4 Preventive / program engine

- Templates, runs, lines, expansion profiles, proof photos, per-line **vendor** assignment (see **046**, **PM_PROGRAM_ENGINE_V1**).
- **Program-run cost entries** (same `ticket_cost_entries` table as tickets, `program_run_id` parent) when migration **047** + finance flags are on.

### 2.5 Operational finance (feature-flagged)

- **Master:** `PROPERA_FINANCE_ENABLED=1`
- **Ticket + preventive cost CRUD:** `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1` (V2 `gateFinance` on portal routes; app `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1`).
- **Tenant ledger posting from approved ticket charges:** `PROPERA_FINANCE_LEDGER_ENABLED=1` (ticket-scoped path; program-run charges do **not** post to ledger in V1 — see **PROPERA_FINANCIAL_LAYER_MAP**).
- Rollups: per-ticket summary view, **UTC month** maintenance spend by property (see migration **042**).

### 2.5a propera-app — owner finance cockpit + unit economics (remote Supabase)

These surfaces assume **`PROPERA_BACKEND=remote`** and the **049** / **050** migrations applied where noted. The **browser** does not write `ticket_cost_entries` or `tenant_ledger_entries` directly; it calls **Next.js `/api/*` routes** that use the **server Supabase client** (same pattern as unit PATCH / tenant mutations).

| Surface | What it does (financially) |
|---------|----------------------------|
| **`/financial`** | **Portfolio-first** owner view: when Leasehold snapshots exist (**094**), shows **billed**, **collected**, **collection rate**, **balance due**, and portfolio **as-of** line. Falls back to lease/ledger placeholders when no import. Sub-nav: Portfolio, properties, imports, maintenance spend, etc. |
| **`/financial/properties/[property]`** | **Units & balances** tab: imported **rent**, **payments**, **balance**, **deposits** (security, key, other, pet — **096–097**), net rent enrichment (**095**); maintenance tab unchanged (12-month trend, categories, ticket drill-down). |
| **`/dashboard` (overview)** | Ticket KPI strip + **financial strip** (Billed, Collected, Collection rate, Balance due) when `NEXT_PUBLIC_PROPERA_FINANCIAL_MENU_ENABLED=1`. **Financial** nav directly under **All Tickets**. |
| **`/financial/imports`** | Manual **Refresh from Leasehold** / **Import all properties** — requires local `leasehold-bridge` + mirror (dev). Production uses office syncher. |
| **`/properties`** | Operational focus: **financial KPIs removed** from the main property grid so money lives under **`/financial`**. |
| **`/properties/.../units/[unitId]`** | **Lease & charges** — persisted in **`unit_leases`** (**049**): monthly rent, security deposit, lease dates, recurring **charge_lines** (billing mode per line: fixed / variable / included / none). **Tenant ledger** — **`GET`** loads `tenant_ledger_entries` for the unit + **`ticket_cost_entries`** tenant-charge lines for cross-check (**Posted** vs **Not posted**); **`POST`** appends **`source_type = manual`** lines (charge, fee, payment, credit, waiver, adjustment) with optional **`effective_date`** and **`notes`**. Unit detail now renders a ledger-based **last 6 months payment history** block. Opens linked tickets from ledger/charge rows when `ticketRowId` matches. |

**Indexes / tables (Supabase):** **049** `unit_leases` (one row per unit catalog id); **050** `tenant_ledger_prop_unit_created_idx` to speed unit ledger reads.

### 2.6 Optional engines (flags)

- **Turnover engine:** `PROPERA_TURNOVER_ENGINE_ENABLED=1` — separate portal surface in app when wired.
- **Meter / utility batch reads:** meter run routes + storage (see migrations **031**, **041** and `registerMeterRunRoutes`).

### 2.7 Ops & compliance

- Dashboard / ops event log (separate from owner portal).
- SMS opt-out, allowlist auth patterns, structured logging.

---

## 3. How propera-app connects to propera-v2

Think in **three channels**:

| Channel | Purpose |
|---------|---------|
| **A. Portal REST** | `propera-app` server-side `fetch` to `{PROPERA_V2_API_URL}/api/portal/...` with portal token — e.g. `src/lib/v2PortalApi.ts` (`fetchV2Portal`). Next routes under `src/app/api/**` expose safe subsets to the browser. |
| **B. Webhook PM proxy** | Staff actions that must hit the **same** brain/GAS-compat paths often go through `POST /webhooks/portal` with structured actions (see `pmV2Proxy`, `mergePortalTickets`, route helpers). |
| **C. Direct reads** | When the app reads tickets/properties from **Supabase** views (SSR or API), that is **read-model** only; writes still go through **V2** or controlled proxies so invariants (locks, dedupe, lifecycle) stay centralized. |

**Finance guardrail:** the browser never inserts into `ticket_cost_entries` directly; only **V2 portal routes** with finance flags create/update those rows. **Manual tenant ledger lines** and **unit lease** upserts go through **propera-app Next routes** (`/api/properties/.../units/.../ledger`, `.../lease`) with the same **tenant-mutation identity gate** as roster edits — they are **not** the V2 ticket-cost DAL; product should keep ticket economics authoritative on tickets, and treat manual ledger lines as **explicit PM/owner adjustments** or one-offs.

---

## 4. Market comparison (plain language)

**Not a 1:1 substitute** for full **PMS + accounting** stacks (e.g. AppFolio, Buildium, Yardi Breeze on the SMB side): those products ship rent roll, GL, trust accounting, owner statements, and vendor AP as first-class modules. Propera’s current finance slice is **operational maintenance cost + optional tenant charge lines**, not full books.

**Closer cousins (conceptually):** CMMS / work-order systems and lightweight **ops** tools — often strong on **tasks and communication**, weaker on **portfolio economics** unless bolted to a PMS. Propera’s direction is the inverse emphasis: **property + work + policy first**, with **money layered on the same objects**; channels (SMS, chat) are how people enter the system, not what the system *is*. Compared to heavy **IWMS/CMMS** (enterprise asset platforms), Propera may stay **lighter on asset hierarchy, capital projects, and procurement** until you deepen there deliberately.

**Differentiator (when fully deployed):** a **property operation system** that ties **accountability** (resolver, lifecycle, policy, audit) to **economics** (cost and charge on the same work objects) — not a generic ticket grid and not “SMS as the product.” **Responsibility-aware orchestration** remains the spine: who owns the next action given a signal, deterministic core, controlled portal edges. That combination is an **ops + maintenance economics** story; pure accounting stacks are **posting & compliance** first; pure CMMS often stops before money.

---

## 5. Finance “depth” — your layers vs today

Below is your Layer 0–5 model mapped to **current** vs **gap**. This is the “how deep” answer without pretending the repo already contains GL/AP.

### Layer 0 — Foundation (data model + APIs)

| You described | Propera today |
|----------------|---------------|
| Ticket cost row + property/month rollups | **Yes** — `ticket_cost_entries`, views in **042**, portal + app when flags on. |
| Preventive / program run costs | **Yes** — **047** + program-run portal routes + `/preventive` UI. |

**Gap:** richer dimensions (WO hierarchies, capex vs opex tags, tax lines) if you need them for reporting — not in V1.

---

### Layer 1 — Operational finance (“what did maintenance cost us”)

| Capability | Today | Gap |
|------------|-------|-----|
| Cost per ticket | Yes | — |
| Cost per preventive run | Yes | Optional **checklist line** on **new** preventive cost (create); edit shows line read-only. |
| MTD / YTD by property | **Yes (UTC)** — current calendar month + **YTD** on `portal_properties_v1` (migration **048**); **`/financial`** portfolio + property cards (**net owner cost (maintenance)**). Main **`/properties`** grid is **operations-only** (no maintenance $ strip on cards). | Rolling **12 months**; fiscal-year non-UTC; richer analytics page. |
| Monthly spend **table** in UI | **Yes** — **`/financial/maintenance-spend`** and property maintenance tab under **`/financial/properties/...`** when wired. | Deeper drill-downs / exports as needed. |

---

### Layer 2 — Vendor finance (“what we owe vendors”)

| Capability | Today | Gap |
|------------|-------|-----|
| Catalog **vendor** for assignment | Yes (tickets + preventive lines) — **vendors** table + APIs. | **Not** full vendor master (terms, tax IDs, insurance certs) unless you extend schema. |
| Invoice PDF on ticket | **Partial** — generic **attachments** / `attachment_urls` on cost rows can hold URLs; no dedicated invoice metadata (number, due date, terms). | **Invoice object** + validation + indexing. |
| Vendor ledger (AP) | **No** — no `vendor_bills` / `vendor_payments` / open balance per vendor. | New tables + posting rules + portal + app. |
| Aging | **No** | Requires Layer 2 invoice + due dates. |

---

### Layer 3 — Tenant finance (“what tenant owes us”)

| Capability | Today | Gap |
|------------|-------|-----|
| Charge amount + status on cost row | Yes | — |
| Post approved charge to **tenant_ledger_entries** | **Yes** (ticket path, flag on) | Program-run charges **explicitly no-op** ledger in V1; tenant **dispute/pay** UX not built. |
| **Unit lease snapshot** (rent, deposit, lease dates, recurring charge template) | **Yes** — **`unit_leases`** (**049**) + **propera-app** lease editor | **Not** imported from PMS; **does not** auto-post rent to `tenant_ledger_entries`. |
| **Manual ledger lines** (fine, late fee, payment, credit, waiver, signed adjustment) | **Yes** — `tenant_ledger_entries` **`source_type = manual`** via **propera-app** `POST .../ledger` | No approval workflow; no tenant auth to view. |
| **Unit hub ledger UI** (posted lines, running balance, ticket-charge cross-check) | **Yes** — **GET .../ledger** + unit page (**050** index) | Balance is **ledger-derived only**; no bank/rent-processor reconciliation. |
| Tenant-visible statement | **No** | Portal/tenant app, payment rails, disputes. |
| Lifetime balance per tenancy | **Partial** — unit-level **running balance** from posted ledger rows + manual lines when operators use the feature | Opening balances, multi-year tenancy history, PMS sync — not built. |

---

### Layer 4 — Budget vs actual

| Capability | Today | Gap |
|------------|-------|-----|
| Budget per property / year | **No** | Budget table + edit UI + allocation by category. |
| Actuals from maintenance costs | **Partial** — actual spend from **042** rollups; tie to **budget** dimension not built. |
| Alerts / thresholds | **No** | Scheduler + notification policy. |
| Category actuals (plumbing vs HVAC) | **Partial** — `entry_type` on cost rows gives coarse buckets; not a full **chart of accounts** mapping. | COA mapping + rules. |

---

### Layer 5 — Owner reporting

| Capability | Today | Gap |
|------------|-------|-----|
| Owner statement PDF | **No** | Reporting job + template + delivery. |
| Income vs maintenance (NOI-style) | **No** — maintenance cost slice + **placeholders** on **`/financial`** for rent/delinquency until a register or PMS feeds them; **unit lease** (**049**) stores **expected** rent template but does not replace accounting. | Data integration + accounting policy. |

---

## 6. Practical “where we stop” today

- **Stops at:** operational cost capture, coarse categorization, optional **ticket-linked** tenant ledger posting, preventive costs, property/month rollups for maintenance spend; **owner-facing `/financial` portfolio** (maintenance economics live; rent/delinquency **explicit placeholders** until integrations); **property-level units table** under finance; **per-unit lease snapshot** (**049**) and **per-unit ledger** (read posted + ticket charges, **manual POST** for one-offs).
- **Does not yet include:** vendor AP, bank sync, automated rent roll / **delinquency from a processor**, tenant payments/disputes as a product loop, budgets, owner packs, or GL.

Use **Layer 1** as the current product horizon; treat **Layers 2–5** as **sequenced product bets** (each usually needs schema + portal + app + policy, not a single “finance toggle”).

---

## 7. Strategy note — finance on top of operations

**Intent:** You are not optimizing for “owning the GL account” alone — you want to **own the operation smartly**: the building, the work, the people, and defensible **economics** tied to real events. That is **property operations**, not a messaging skin on tickets.

**Short answer:** keeping a strong **operational** core and **adding finance as layers** (cost → charge → vendor AP → budget → owner reporting) matches that intent — *if* scope and sequencing stay disciplined so the **resolver and lifecycle** remain authoritative.

**Why it can put you ahead**

- **Operational CMMS** products often stop at work completed and attachments; money is an export to Excel or a manual entry in the PMS.
- **PMS / accounting** products own rent and GL but often treat **maintenance causality** (who triggered work, schedule policy, SMS thread) as a shallow attachment to a generic charge.
- **Propera’s spine** is *signal → ownership → lifecycle* for the **asset and portfolio**. **Layer 1 finance** (“what did this ticket/run cost, what are we charging back”) is the natural **next column on the same row** — not a separate app. That is how you **own the account smart**: numbers that trace to work, not work that chases numbers in a spreadsheet.

**What “ahead” does *not* mean**

- Replacing QuickBooks/Yardi for **full** GL, trust accounting, and bank rec in v1 — that is a different product and buyer. “Ahead” here means **best-in-class property maintenance operations with economics on the same objects**, then optional depth (vendor AP, budgets, owner packs) for portfolios that outgrow spreadsheets — **not** “we replaced your accountant.”

**How to not lose the plot**

- Ship **Layer 1** with ruthless clarity (ticket + preventive costs, rollups, tenant charge + ledger where you already have schema).
- Treat **Layers 2–5** as **sequenced bets** tied to revenue (e.g. vendor AP for portfolios with real vendor spend; budgets when owners ask for variance).
- Keep the **deterministic core** (resolver, lifecycle, dedupe) as the authority; finance remains **expression and posting** on top — consistent with North Compass doctrine in the repo.

---

## 8. What to build next in finance (recommended order)

**Principle:** finish **Layer 1** as a *credible product surface* (operators trust the numbers and can act on them daily) before opening **vendor AP** or **budget** complexity.

| Priority | Build | Why now |
|----------|--------|--------|
| **P0** | **Layer 1 visibility** — property-level **MTD + YTD** (or rolling 12m) maintenance spend using existing `ticket_cost_entries` + rollup views; wire **propera-app** properties / dashboard so PMs do not export to Excel for the basics. | **Shipped (v1):** migration **048** — `portal_properties_v1` UTC **YTD** columns; maintenance rollups on **`/financial`** property cards (**net owner cost (maintenance)**). **propera-app** **de-scoped** maintenance $ from main **`/properties`** grid so finance is centered under **`/financial`**. *Gap:* rolling 12m, non-UTC fiscal year; rent/delinquency still placeholders until PMS/rent register. |
| **P0** | **Unit economics + ledger (thin Layer 3)** — one place to see lease template + what hit the tenant ledger + ticket charge alignment. | **Shipped:** **049** `unit_leases`, **050** ledger index, **`/api/.../lease`** + **`/api/.../ledger`**, unit page **lease editor**, **ledger table** + **manual** line modal + **ticket tenant-charge** cross-check. *Gap:* no auto-rent posting from lease; ticket charges still **authoritative** via ticket + V2 ledger flag. |
| **P0** | **Receipts on cost rows** — first-class UX to attach **images/PDFs** to a cost line (reuse `attachment_urls` + pm-attachments flow); optional single “receipt” slot in UI. | **Shipped:** shared **`CostEntryReceiptsField`** on ticket + program-run costs; **`/api/pm/upload-attachment`** accepts **PDF** + images (max 6 URLs per row). |
| **P1** | **Preventive costs per line** — expose `program_line_id` in UI when adding/editing a cost on `/preventive` (API already supports validation). | **Shipped (create):** optional checklist line on **new** cost; edit shows line read-only. *Gap:* PATCH `program_line_id` if you need to move costs between lines. |
| **P1** | **Charge + ledger policy for program-run costs** — if product needs **tenant chargeback** on preventive work, extend ledger posting beyond ticket-only V1 (with explicit rules: roster, unit, `ticket_id` null). | Only if customers ask; skip if preventive spend is owner-only. |
| **P2** | **Layer 2 precursor — invoice metadata** on cost or small `vendor_invoice` stub: invoice #, due date, paid status already partially modeled; no full AP aging yet. | Bridges to vendor ledger later without committing to full AP in one step. |
| **Defer** | Full **vendor AP**, **budget vs actual**, **owner PDF packs**, **tenant payment/dispute** — until Layer 1 is default workflow for target customers. | Avoid parallel big surfaces; each needs policy + UX + support load. |

**Single metric to optimize:** % of maintenance spend captured **in-system** with a receipt or note and visible on a **property** view without spreadsheet — not “number of GL accounts.”

---

## 9. Documentation maintenance

When you add a major V2 surface or app proxy:

1. Update **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** (ops + migrations).  
2. Update **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** if GAS-visible behavior changes.  
3. Update **[PROPERA_FINANCIAL_LAYER_MAP.md](./PROPERA_FINANCIAL_LAYER_MAP.md)** for anything touching costs/ledger.  
4. Update **this file** only when **cross-cutting** capability or finance-depth positioning changes — including **§8 (next finance builds)** when priorities shift.
5. When adding **propera-app-only** finance routes (lease/ledger) or **Supabase** tables consumed only by the app, note them in **§2.5a** and **PROPERA_FINANCIAL_LAYER_MAP.md** if the data model is part of the financial story.

---

*Last aligned to repo capabilities as of migrations **042**, **046**, **047**, **048**, **049**, **050**; V2 portal finance routes in `registerPortalRoutes.js`; and **propera-app** `/financial` + unit **lease/ledger** APIs.*
