# Accounting import signals — Leasehold mimic & materialization

**Purpose:** Single design doc for turning Leasehold from a **read-only dashboard feed** into a **channel-agnostic accounting adapter** that emits structured signals so Propera **records and reacts** — not only displays. This is the missing half of Phase 1.5: ingest exists; **mimic loop does not**.

**Audience:** product, engineering, next agent implementing lease materialization, ledger mimic, or bridge signal export.

**Related (do not duplicate):**

- [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) — phased finance plan; Phase 1.5 = snapshot read (**shipped**); Phase 2 = rent roll / delinquency
- [FINANCIAL_INTAKE_V1.md](./FINANCIAL_INTAKE_V1.md) — chat finance routes (`payment_received`, `tenant_charge_onetime`, …); import signals **reuse the same DAL paths**, deterministic not LLM
- [../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md](../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md) — mirror → staging → import ops; **never write back to Leasehold**
- [../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md](../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md) — cockpit vs brain
- [../supabase/queries/README_TENANT_RECONCILE.md](../supabase/queries/README_TENANT_RECONCILE.md) — **Step 0** manual roster ↔ LH identity reconcile (in progress)

**North compass:** Leasehold is the **source until cutover**. Propera is the **destination**. Import is a **replication pipe**, not the end state. Every LH action that matters should eventually exist as a Propera fact with a stable idempotency key — then "take over" means switching **who originates** the fact, not rebuilding history.

> **One line:** Staff write Leasehold → bridge reads the write → sends the matching signal → brain repeats the action in Propera → policies react.

---

## Problem today

```text
Leasehold (.Dat files)
        ↓ import (read-only)
tenant_account_snapshots     ← accounting truth (rent, balance, dates, ~80 posted lines in payload)
        ↓
/financial pages             ← DISPLAY
        ↓
(nothing deterministic)      ← brain does not get lease/payment events
```

Propera acts like a **dashboard on top of Leasehold**, not an **operations system** on top of it. That was intentional for Phase 1.5 (display without displacing incumbent GL). The product gap is the other half: **Propera-owned records and decisions** beside the import.

**Partial exception (Propera-native, not LH mimic):** Stripe Checkout (**migration 107**) — tenant pay → webhook → `tenant_stripe_payments` + optional `tenant_ledger_entries` (`source_type: stripe_checkout`). That is Propera recording its own payment rail; it does **not** replace mimicking LH posted lines.

---

## Target architecture (channel-agnostic)

Same spine as SMS, Telegram, portal chat, Stripe:

```text
INBOUND (any channel)
→ Adapter (transport only — package in)
→ Signal / normalization
→ Brain (resolve unit, validate, dedupe, policy)
→ Domain posting (unit_leases, tenant_ledger_entries, …)
→ Outgate / policies (balance reminder, renewal, lifecycle)
```

For Leasehold:

```text
Staff acts in Leasehold UI
      ↓
Leasehold writes .Dat files
      ↓
leasehold-bridge (adapter — parse only, no decisions, no Postgres)
      ↓
Structured signals[]  (+ optional state_facts for KPI snapshots)
      ↓
Propera brain: handleAccountingImportSignals
      ↓
DAL post (same paths as FINANCIAL_INTAKE V2 chat routes)
      ↓
Policies (balance reminder pause, delinquency tier, renewal desk, turnover)
```

**Bridge must NOT:** write to Leasehold or `\\lhdata`, post to Postgres, run reminders, decide renewals, or bypass the brain.

---

## Two packages from the bridge (not one blob)

| Package | Meaning | Example | Propera target |
|---------|---------|---------|----------------|
| **State sync** | What is true **right now** for this unit? | Rent, lease dates, deposits, recurring charge template | `unit_leases` fact fields; keep `tenant_account_snapshots` for official KPI balance |
| **Event signal** | Something **happened** on this unit | Payment posted, monthly billing, fine, late fee | `tenant_ledger_entries` (one row per event, deduped) |

Today export ships mostly **state** buried in `payload.posted_transactions`. Target: **events are first-class** in `signals[]`.

Display pages may keep reading snapshots for portfolio KPIs and **as-of** balance. **Automation reads the Propera mirror + signals.**

---

## Leasehold file split (terms vs events)

Each property `RA####` group uses different files:

| What | Leasehold file | Staff action |
|------|----------------|--------------|
| Base rent, lease dates, tenant name, phones | `RA####.DAT` (unit master) | Set/changed rent or lease term |
| Recurring charge slots (water, pet, parking hints) | `RA####.DAT` segment 1 + billing hints | Recurring setup |
| Deposits (security, key, pet, other) | `RA####S.Dat`, `RA####R.Dat` | Deposit posted / returned |
| Payments, billing, fines, late fees | `RA####H.Dat` | Day-to-day ledger actions |

```text
RA0003.DAT      ← terms (who, rent, dates)
RA0003S/R.Dat   ← deposits
RA0003H.Dat     ← events (ledger stream)
```

**Materialization lanes:**

| Lane | LH source | Propera table | Changes when |
|------|-----------|---------------|--------------|
| Lease shell | `.DAT` + S/R.Dat + ancillary | `unit_leases` | Rent renewal, deposit move, recurring setup |
| Ledger events | `H.Dat` posted lines | `tenant_ledger_entries` | Payment, billing, fine, late fee |

Office syncher fingerprint watches all four file types — import runs only when **any** of them changed (not on every timer tick).

---

## Sync cadence (not "rewrite every 5 minutes")

The Mon–Sat **5-minute** job is a **poll**, not a blind re-import:

```text
Every 5 min:  fingerprint LH files
              unchanged → skip (no POST, no DB write)
              changed   → export → import once
```

| Scenario | What Propera writes |
|----------|---------------------|
| Timer tick, LH unchanged | **Nothing** |
| Staff posts payment (`H.Dat` changed) | Snapshot balance update; **one new** ledger event (step 2); lease shell often no-op |
| Staff changes rent (`.DAT` changed) | Lease shell UPDATE; staff Propera fields preserved |
| Staff sets `renewal_status` in Propera | **Never** overwritten by import |

**Step 1 (lease materializer):** upsert terms when import runs; same values → harmless no-op (optional compare-before-write optimization).

**Step 2 (ledger mimic):** **idempotency_key** required — same LH line on re-import → skip, never duplicate.

---

## Canonical signal shape

Deterministic from LH parse — **no LLM**. Aligns with `financialSignalExtract` / FINANCIAL_INTAKE V2 routes.

### `lease_terms_sync` — locked contract (v1)

**All channels** (Leasehold import, portal cockpit, Jarvis confirm, future agents) must emit this envelope. The brain **only** validates, dedupes, merges staff-owned fields, and posts — it does **not** parse `.Dat` files or LH snapshot blobs.

```json
{
  "schema_version": 1,
  "kind": "lease_terms_sync",
  "source_channel": "leasehold_import",
  "property_code": "WESTFIELD",
  "unit_catalog_id": "uuid-of-units-row",
  "unit_label": "412",
  "idempotency_key": "leasehold:WESTFIELD:412:2026-06-15:lease_terms:a1b2c3d4e5f6",
  "effective_at": "2026-06-15T12:00:00.000Z",
  "body": {
    "rent_cents": 240600,
    "lease_start": "2025-06-01",
    "lease_end": "2026-05-31",
    "security_deposit_cents": 240600,
    "other_deposit_cents": null,
    "pet_deposit_cents": 30000,
    "key_deposit_cents": 5000,
    "charge_lines": [
      { "type": "water", "mode": "variable", "amount_cents": 4500 },
      { "type": "pet_fee", "mode": "fixed", "amount_cents": 5000 }
    ],
    "tenant_net_rent_cents": 220600,
    "rent_subsidy_cents": 20000,
    "rent_subsidy_label": "Credit",
    "net_rent_derived_at": "2026-06-15T12:00:00.000Z",
    "deposits_derived_at": "2026-06-15T12:00:00.000Z"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `kind` | yes | Must be `lease_terms_sync` |
| `source_channel` | yes | `leasehold_import` \| `portal_lease_edit` \| `jarvis_confirm` \| `agent_proposal` |
| `property_code` | yes | Uppercase portal property code |
| `unit_catalog_id` | yes | Resolved before brain (adapter or cockpit) |
| `idempotency_key` | yes | Must contain `:lease_terms:`; fingerprint suffix changes when body changes |
| `effective_at` | yes | ISO timestamp of intent |
| `body` | yes | LH-owned fact fields only — see field ownership § |

**Brain validation rules** (`leaseTermsSyncSignal.js`):

1. Envelope schema + allowed `source_channel`
2. `body` cents non-negative or null; dates `YYYY-MM-DD`; `lease_end >= lease_start`
3. `charge_lines[]` — each line has `type`, `mode` ∈ {fixed, variable, included, none}, optional `amount_cents`
4. Occupied gate — at least one of: `rent_cents > 0`, lease dates, deposit cents
5. Dedupe — same `idempotency_key` in batch → skip; unchanged body vs existing row → skip
6. Post — upsert `unit_leases`; **never** write `renewal_status`, `renewal_notes`, `notes`

**Producer responsibilities:**

| Producer | Normalizes | Posts |
|----------|------------|-------|
| `leasehold_import` adapter | LH snapshot fact → signal body (pet fee, deposits, ancillary) | Brain |
| Portal lease edit (future) | Form → signal body | Brain |
| Jarvis confirm (future) | Confirmed proposal → signal body | Brain |

**V2 route:** `POST /api/portal/financial/accounting-import-signals`

```json
{
  "property_code": "WESTFIELD",
  "synced_at": "2026-06-15T12:00:00.000Z",
  "signals": [ { "...lease_terms_sync..." } ]
}
```

Legacy LH path (transitional): send `matched: [{ unitId, fact }]` — **adapter** (`normalizeLeaseholdFactToLeaseTermsSync.js`) converts to signals before brain posts.

---

### Event signals (ledger — Step 2, **pilot shipped**)

**Shipped envelope** (same flat shape as `lease_terms_sync` — brain validates top-level `kind`):

```json
{
  "schema_version": 1,
  "kind": "payment_received",
  "source_channel": "leasehold_import",
  "property_code": "WESTFIELD",
  "unit_catalog_id": "uuid-of-units-row",
  "unit_label": "101",
  "idempotency_key": "leasehold:WESTFIELD:101:2026-06-03:payment:253100:seq45",
  "effective_at": "2026-06-15T12:00:00.000Z",
  "body": {
    "effective_date": "2026-06-03",
    "amount_cents": 253100,
    "balance_after_cents": 0,
    "description": "CK",
    "reference": "1042",
    "lh_kind": "payment",
    "posted_sequence": 45,
    "confidence": "high"
  }
}
```

**Pilot scope (2026-06-15):** bridge emits ledger event signals only for units listed in `leasehold-bridge/config/ledger-mimic-pilot.json` — default **WESTFIELD unit 101**. All other units: snapshots + `lease_terms_sync` only.

Legacy transport wrapper (below) is **not** used by the shipped bridge — kept for channel-agnostic future (Jarvis batch, etc.):

```json
{
  "schema_version": 1,
  "channel": "ACCOUNTING_IMPORT",
  "source_system": "leasehold",
  "received_at": "2026-06-10T12:00:00Z",
  "transport": {
    "property_code": "WESTFIELD",
    "ra_group": "RA0003",
    "mirror_fingerprint": "abc123",
    "import_batch_id": "uuid"
  },
  "body": {
    "kind": "payment_received",
    "unit_label": "412",
    "tenant_name": "Smith",
    "effective_date": "2026-06-03",
    "amount_cents": 253100,
    "balance_after_cents": 0,
    "description": "CK",
    "recurring": false,
    "reference": "1042",
    "idempotency_key": "leasehold:WESTFIELD:412:2026-06-03:payment:253100:seq45",
    "confidence": "high"
  }
}
```

**Rules:**

- Bridge sets `kind` + facts + `idempotency_key`.
- Brain resolves `unit_label` → `unit_catalog_id`, matches `tenant_roster_id` when verified.
- Brain validates, dedupes, posts — same DAL as portal / chat finance.
- `confidence` is always `high` for LH parse (deterministic adapter).

---

## Signal kinds

Mapped from `posted_transactions`, deposit parsers, and unit master (see `leasehold-bridge` `parseTransactionStream`, `classifyLeaseholdCharge`, `extractAncillaryCharges`).

| `body.kind` | LH source | Brain posts to | Example triggers (later) |
|-------------|-----------|----------------|--------------------------|
| `lease_terms_sync` | Unit master + deposits + ancillary | `unit_leases` (rent, dates, deposits, `charge_lines`) | Renewal desk visibility |
| `recurring_charge` | Water, parking, pet monthly | Update `charge_lines` on lease | Obligation tracking |
| `monthly_billing` | `kind=billing` on H.Dat | Ledger **charge** (rent + extras split) | Expected vs collected |
| `payment_received` | Payment line on H.Dat | Ledger **payment** | Pause balance reminder, delinquency tier |
| `late_fee` | Late fee line | Ledger **fee** | Collections policy |
| `fine` | Legal / NSF / fine labels | Ledger **charge** or **fee** | Staff audit log |
| `one_time_charge` | Key, FOB, other chg | Ledger **charge** | — |
| `deposit_posted` | S.Dat / R.Dat | Deposit fields on lease | Move-in / turnover |
| `deposit_returned` | R.Dat credit | Ledger **credit** / deposit adjustment | Turnover close |
| `adjustment` | ADJ lines | Ledger **adjustment** | Balance reconcile check |
| `subsidy_credit` | ADJ / credit pattern | `tenant_net_rent_cents` enrichment | Subsidized units |

Chat finance route alignment (FINANCIAL_INTAKE V2):

| Import `kind` | Chat route equivalent |
|---------------|----------------------|
| `payment_received` | `payment_received` |
| `fine`, `one_time_charge`, `late_fee` | `tenant_charge_onetime` |
| `lease_terms_sync`, `recurring_charge` | `tenant_charge_recurring` / lease amendment |

---

## Staff action → signal → Propera repeat (examples)

**Payment:** Staff records check — unit 412, $2,531 on Jun 3 → `H.Dat` CK line → signal `payment_received` → brain posts `tenant_ledger_entries` (`entry_kind: payment`, `source_type: accounting_import`) → balance reminder policy may pause.

**Billing:** June monthly billing → signal `monthly_billing` with `rent_cents` + `extras_cents` → ledger charge rows.

**Fine:** $100 noise fine → signal `fine` → ledger charge (same as chat `tenant_charge_onetime`).

**Lease terms:** Rent, dates, water/pet/parking from unit master → signal `lease_terms_sync` → upsert `unit_leases`; refresh LH facts; **preserve** `renewal_status`, `renewal_notes`, staff `notes`.

---

## Field ownership (never mix)

| Layer | Table | LH import overwrites? | Staff / Propera owns |
|-------|-------|----------------------|----------------------|
| Accounting truth (display + official balance) | `tenant_account_snapshots` | Yes — every changed import | — |
| Lease terms mirror | `unit_leases` — rent, dates, deposits, `charge_lines` amounts | Yes — fact fields | `renewal_status`, `renewal_notes`, `notes`; charge **modes** merge carefully |
| Ledger events mirror | `tenant_ledger_entries` | Append-only via idempotent import | Manual + ticket + Stripe lines untouched |
| Ops identity | `tenant_roster` | **No auto-overwrite** — reconcile workflow | Phone for SMS, `active`, portal login |
| Enrichment | `unit_leases` net rent, escalators, market rent | Derived columns only | Propera-only fields |

**Lease template shape from snapshot (already in bridge export):**

```text
unit_leases
├── rent_cents              ← base rent
├── security_deposit_cents  ← + other / pet / key
├── lease_start / lease_end
└── charge_lines[]          ← recurring only (water variable, pet/parking fixed)
      late fees, fines, one-offs → ledger events, NOT charge_lines
```

Reuse `buildPrefilledChargeLines` logic server-side (`propera-app/src/lib/unitChargePrefill.ts`).

---

## Brain handler flow (deterministic)

**Shipped:** `propera-v2/src/brain/financial/handleAccountingImportSignals.js`

```text
1. Receive   signals[] (preferred) OR matched LH facts (adapter converts)
2. Validate  leaseTermsSyncSignal envelope + body
3. Dedupe    idempotency_key in batch; compare-before-write vs existing row
4. Post      postLeaseTermsSync → unit_leases (preserve renewal_status, notes)
5. Policy    (Step 4 — not yet)
6. Audit     source_channel + idempotency_key on result
```

Process **signals in order**: `lease_terms_sync` first per unit, then events by `effective_date` (when ledger mimic ships).

**Import API:**

```text
POST /api/portal/financial/accounting-import-signals
{
  "property_code": "WESTFIELD",
  "synced_at": "...",
  "signals": [ { "kind": "lease_terms_sync", ... } ]
}
```

**propera-app** upserts snapshots, then forwards bridge **`signals[]`** (preferred) or legacy `matched` facts.

---

## Idempotency keys

Required for every signal. Stable across re-import.

**`lease_terms_sync`:** `{source}:{property}:{unit_label}:{date}:lease_terms:{body_fingerprint}` — fingerprint changes when rent, dates, deposits, or charge_lines change.

**Event signals (ledger):**

```text
leasehold:{property_code}:{unit_label}:{effective_date}:{kind}:{amount_cents}:{seq_or_ref}
```

Examples:

```text
leasehold:WESTFIELD:412:2026-06-03:payment:253100:seq45
leasehold:WESTFIELD:412:2026-06-01:billing:253100
leasehold:WESTFIELD:412:2026-06-10:lease_terms:v1
```

**Schema (shipped — migration 108):** `tenant_ledger_entries.source_type` includes `accounting_import`; dedupe via **`import_idempotency_key text`** + unique partial index. `source_id` stays `null` for import lines (Stripe/ticket rows continue using `source_id` uuid).

**Verify pilot:** `supabase/queries/verify_ledger_mimic_westfield_101.sql`

---

## Build order (do not skip)

| Step | Deliverable | Outcome | Status |
|------|-------------|---------|--------|
| **0** | Tenant roster ↔ LH reconcile | Verified `tenant_roster_id` per occupied unit; names/phones aligned | **In progress** — SQL workflow `supabase/queries/README_TENANT_RECONCILE.md`; WESTFIELD/PENN rounds |
| **1** | Lease terms intent signal + brain post | Full `unit_leases` from validated `lease_terms_sync`; Renewals Set works | **Shipped** — `handleAccountingImportSignals.js` + `leaseTermsSyncSignal.js`; LH adapter converts facts |
| **2** | Ledger materializer + migration **108+** | `posted_transactions` → `tenant_ledger_entries` (`accounting_import`, deduped) | **Pilot** — WESTFIELD unit **101** only (`ledger-mimic-pilot.json`) |
| **3** | Bridge emits `signals[]` at source | Bridge sends `lease_terms_sync`; app forwards signals (not matched facts) | **Partial** — lease + ledger pilot signals |
| **4** | Policy hooks | New payment → reminder pause; LH tenant change → occupancy rotate | **Not started** |

**Prerequisite rule:** finish **Step 0** for a property before trusting Step 1–3 automation there (ledger and reminders need `tenant_roster_id`).

**Effort estimate (v1 mimic loop):** ~2–3 weeks focused — **not** a multi-month rewrite. Parsing ~85% done; gap is wiring.

---

## Cutover / strangler pattern (same as GAS → V2)

```text
Phase A: LH writes, Propera mirrors     ← **in progress** (lease + ledger pilot)
Phase B: LH writes, Propera mirrors + enriches + triggers
Phase C: Propera writes rent, LH optional export/backup
Phase D: Propera is SoR; LH read-only or retired
```

**Not** write-back to Leasehold in Phases A–B. **Automated mirror on import** is not the same as asking PMs to manually re-key payments (Phase 1 read rule still applies to humans).

Official `/financial` balance may continue to come from **snapshot** (LH truth) during parallel-run. `tenant_ledger_entries` from import = **operational mirror** for brain, unit hub, and policies — until cutover gate passes (see [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) Phase 6).

---

## End state — Propera financially complete (owner intent)

Leasehold mimic is **not** the forever architecture. It is the **on-ramp** so the owner can **switch to Propera** when finance is trustworthy.

| Capability | Why it matters for cutover |
|------------|----------------------------|
| **Own payment recording** | Stripe webhooks, easy manual exception, chat `payment_received` — staff rarely touch LH for receipts |
| **Bank reconciliation** | Bank CSV auto-match + exception queue — month-end without spreadsheet |
| **Automation-first capture** | LH mimic, bill scan, webhooks, lifecycle deposit posts — **less staff in any system** |
| **Complete report section** | `/financial/reports` — rent roll, ledgers, deposits, AP aging, bank rec status, accountant export pack (Phase 5b) |
| **Native ledger truth** | All rails converge on `tenant_ledger_entries` + future GL — one spine for ops and accounting |

**Build order implication:** Steps 0–3 (this doc) unblock parallel-run. Phases 2–5b + 6 in the finance roadmap deliver **financial completeness** and the **cutover gate**. Do not stop at display-only snapshots.

---

## Implementation status

| Piece | Location | Status |
|-------|----------|--------|
| LH parsers (H.Dat, .DAT, S/R.Dat) | `../leasehold-bridge/src/` | **Shipped** |
| Snapshot import | `propera-app/src/lib/server/accountingSnapshotImport.ts` | **Shipped** |
| Partial lease enrichment (net rent, deposits only) | `propera-app/src/lib/server/leaseEnrichmentImport.ts` | **Superseded by materializer** |
| **`lease_terms_sync` contract** | `docs/ACCOUNTING_SIGNAL_SCHEMA.md` § locked contract | **Shipped** |
| **LH → signal adapter** | `src/adapters/leasehold/normalizeLeaseholdFactToLeaseTermsSync.js` | **Shipped** |
| **Brain validate + post** | `handleAccountingImportSignals.js`, `leaseTermsSyncSignal.js`, `postLeaseTermsSync.js` | **Shipped** |
| Charge line prefill (UI) | `propera-app/src/lib/unitChargePrefill.ts` | **Shipped** (UI); LH normalization in V2 adapter |
| Chat finance post paths | `propera-v2/src/brain/financial/handleFinancialCapture.js` | **Shipped** |
| Import route | `POST /api/portal/financial/accounting-import-signals` | **Shipped** |
| Stripe native payments | migration **107**, V2 webhooks | **Shipped** (Propera-native, not LH mimic) |
| **`signals[]` export at bridge (lease)** | `leasehold-bridge/src/signals/buildLeaseTermsSyncSignals.js` | **Shipped** |
| **`signals[]` export at bridge (ledger pilot)** | `leasehold-bridge/src/signals/buildLedgerEventSignals.js` + `config/ledger-mimic-pilot.json` | **Pilot** — WESTFIELD unit 101 |
| App signal enrich + forward | `enrichAccountingImportSignals.ts` → V2 (lease + ledger kinds) | **Shipped** |
| Ledger brain validate + post | `ledgerEventSignal.js`, `postLedgerEventSignal.js`, `handleAccountingImportSignals.js` | **Shipped** (pilot units only at bridge) |
| `accounting_import` ledger source | migration **108** `108_accounting_import_ledger.sql` | **Shipped** — apply before pilot import |
| Tenant reconcile UI | propera-app `/financial` | **Not started** (SQL workflow only) |

---

## Next steps (after WESTFIELD unit 101 pilot validates)

Rollout and cutover order — **do not skip compare before expanding scope**.

| # | Step | Outcome |
|---|------|---------|
| **1** | **Deploy** migration **108** + V2 + app + bridge; run WESTFIELD sync | Unit 101 ledger rows in `tenant_ledger_entries`; re-sync → `ledger_skipped_existing` only |
| **2** | **Compare** | Run `verify_ledger_mimic_westfield_101.sql` — snapshot balance vs ledger sum, line count vs `posted_transactions`, spot-check LH screen |
| **3** | **Expand pilot** | Add units to `ledger-mimic-pilot.json` → full WESTFIELD building; repeat compare per unit or sample |
| **4** | **Step 4 — policy hooks** | `payment_received` → pause balance reminder; tenant change → occupancy hints |
| **5** | **Phase 5b reports** (WESTFIELD first) | Tenant ledger book, rent roll, deposit register from Propera tables — accountant sign-off vs LH |
| **6** | **Cutover doc** (per building) | Cutoff date, balance source flag (snapshot vs ledger), double-post rules |
| **7** | **Flip write authority (Phase C)** | New payments/charges in Propera only (Stripe + Record Payment + future billing); stop LH entry for that building |
| **8** | **Phase 2 native billing** | Propera emits `monthly_billing` — same signal shape, `source_channel` ≠ `leasehold_import` |
| **9** | **Phase 6 gate** | Bank rec, GL, full accountant pack → retire LH for portfolio slice |

**What Propera already writes natively (not LH mimic):** manual ledger (`manual`), Stripe (`stripe_checkout`), ticket chargebacks (`ticket_cost_entry`), `property_expenses`, renewals desk fields on `unit_leases`. After cutover, **new** tenant money should use these paths — mimic handles **history only**.

**Still LH-read until later phases:** vendor AP/checks, building GL, bank reconciliation, full accountant month-end pack.

---

## When changing this system — update these docs

| Change | Update |
|--------|--------|
| New signal `kind` or idempotency rule | This file |
| Phase ships (materializer, handler, migration) | This file § Implementation status; [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md); [AGENTS.md](../AGENTS.md) finance table |
| Bridge export shape | `../leasehold-bridge/MANIFEST.md`; this file |
| Ops / env steps | [FINANCIAL_LEASEHOLD_SYNC.md](../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md) |

---

*Last aligned: 2026-06-15 — Step 2 ledger mimic pilot (WESTFIELD unit 101); migration 108; next: validate 101 → expand building → 5b reports → cutover.*
