# Preventive / Tasks Engine — V1 (locked definition)

**Status:** Discussion scaffold → **implementation baseline** for baby-step build.  
**Scope:** Program runs + checklist lines only. **Not** scheduling, tenant SMS outreach, or AI planning.

---

## Purpose

One engine handles HVAC, painting, water heater, gutters, cleaning, etc. — **not** separate products per service.

**Anchor:** `Program Run` (parent) + `Program Lines` (checklist).  
**Separation:** This path is **not** reactive tenant maintenance tickets. Tenant intake (`handleInboundCore`, finalize ticket flow) must **not** own program creation.

---

## Core idea

| Input | Example |
|--------|---------|
| Property + template + optional instructions | “Start HVAC maintenance for Murray” |

**Output:**

- One **program run**: e.g. “Murray — HVAC Maintenance”
- Many **lines**: Unit 101 Open, Unit 102 Open, …, Common Area Open — staff mark each complete.

Templates define **how lines expand** (units vs floors vs common-only), because each service has a different progress model.

---

## Tables (V1 — dedicated PM/Task tables)

Reason: operational building programs are not the same as tenant-originated maintenance rows. Use dedicated tables; do **not** overload `tickets` / reactive WI flow for V1.

### `program_templates`

Defines behavior and label.

| Column | Example |
|--------|---------|
| `template_key` | `HVAC_PM` |
| `label` | HVAC Maintenance |
| `expansion_type` | See expansion types below |

**Seed templates (V1):**

| template_key | label | expansion_type |
|--------------|-------|----------------|
| `HVAC_PM` | HVAC Maintenance | `UNIT_PLUS_COMMON` |
| `WATER_HEATER_PM` | Water Heater Maintenance | `UNIT_PLUS_COMMON` |
| `COMMON_AREA_PAINT` | Common Area Painting | `FLOOR_BASED` |

### `program_runs`

One active program/task per row.

| Field | Example |
|-------|---------|
| `id` | uuid |
| `property_code` | `MURRAY` |
| `template_key` | `HVAC_PM` |
| `title` | Murray — HVAC Maintenance |
| `status` | `OPEN` / `IN_PROGRESS` / `COMPLETE` |
| `created_by` | `STAFF_NICK` / `PORTAL` |
| `created_at` | timestamp |

### `program_lines`

Checklist / progress rows.

| Field | Example |
|-------|---------|
| `id` | uuid |
| `program_run_id` | parent fk |
| `scope_type` | `UNIT` / `COMMON_AREA` / `FLOOR` |
| `scope_label` | Unit 2A / 1st Floor / Common Area |
| `status` | `OPEN` / `COMPLETE` |
| `completed_by` | staff id |
| `completed_at` | timestamp |
| `notes` | optional |

---

## Expansion types → line generators

| expansion_type | Used for | Line generation |
|----------------|----------|-----------------|
| `UNIT_PLUS_COMMON` | HVAC, water heater, filters, smoke detectors | Active units from roster + common area line |
| `FLOOR_BASED` | Painting, hallway cleaning, floor inspections | Floors from property metadata **or** defaults until metadata exists |
| `COMMON_AREA_ONLY` | Lobby repair, exterior lights, boiler room | Common / site-scoped lines only |
| `CUSTOM_MANUAL` | One-offs | Minimal or empty initial lines; staff add lines later (later phase) |

**Pattern:** `template_key` → `expansion_type` → **deterministic line generator** (no per-service hardcoding in core logic).

---

## Smart creation (`createProgramRun`)

**Inputs:** `{ propertyCode, templateKey, createdBy }` (+ optional instructions later).

**Flow:**

1. Resolve property name/code → `property_code`.
2. Resolve intent → `template_key`, load `program_templates`.
3. By `expansion_type`:
   - **UNIT_PLUS_COMMON:** load active units for property → one line per unit + Common Area.
   - **FLOOR_BASED:** load floor metadata or default floors (e.g. 1st–3rd + Stairwell) → one line per floor/area.
4. Insert one `program_runs` row + N `program_lines` in one transaction.
5. Return the new run (and lines) to the client.

**HVAC example:** Murray → roster units + Common Area.  
**Painting example:** Murray → 1st Floor, 2nd Floor, 3rd Floor, Stairwell (per template/defaults).

---

## Boundary (critical)

| This engine | Not this |
|-------------|----------|
| Owner / PM / staff starts an **operational program** | Tenant says “sink is leaking” → reactive ticket |
| Controlled checklist in Postgres | Tenant intake merge / `finalizeMaintenance` as the creator |

V1 **entry points:**

1. **propera-app:** form — property, template, “Create”.
2. **Later:** staff natural language — same `createProgramRun` (or thin wrapper) underneath.

App and staff lane **must** call the **same** V2 function.

---

## propera-app API (V1)

propera-app **does not** write DB directly. It calls V2; V2 validates, persists, logs (`event_log` as appropriate).

**Base path:** `/api/portal/…` (same auth as other portal routes).

| Need | Method | Path |
|------|--------|------|
| List templates (dropdown) | GET | `/api/portal/program-templates` |
| List runs | GET | `/api/portal/program-runs` |
| One run + lines | GET | `/api/portal/program-runs/:id` |
| Start program | POST | `/api/portal/program-runs` |
| Mark line complete | PATCH | `/api/portal/program-lines/:id/complete` |
| Reopen line | PATCH | `/api/portal/program-lines/:id/reopen` |

**POST body (create):** `{ "propertyCode": "MURRAY", "templateKey": "HVAC_PM", "createdBy": "PORTAL" }` — or `property` (display name) instead of `propertyCode`.

**PATCH complete body:** `{ "completedBy": "STAFF_NICK", "notes": "" }` (optional).

Auth: same portal token pattern as existing portal routes (`X-Propera-Portal-Token` / `PROPERA_PORTAL_TOKEN`).

**Migration:** `supabase/migrations/018_program_engine_v1.sql`

---

## propera-app UI (V1)

**Route:** `/preventive` (sidebar **Preventive**). Proxies to V2 via same-origin `/api/program-templates`, `/api/program-runs`, `/api/program-lines/...`.

**List:** Cards — title, status (e.g. 8/22 complete), template label, property, created time → **View checklist**.

**Detail:** Right panel — scope, status, Mark complete / Reopen.

---

## Baby-step implementation order

1. **Schema:** migrations for `program_templates`, `program_runs`, `program_lines`; seed three templates.
2. **Engine:** `createProgramRun({ propertyCode, templateKey, createdBy })` + line generators per expansion type.
3. **API:** four routes above + validation + structured logging.
4. **propera-app:** tab, list, drilldown, complete/reopen.
5. **Staff NL command** — only after app path is stable; maps to same engine.

---

## Out of scope for V1

- Scheduling / cron / “10 per day” tenant outreach  
- Tenant SMS for access (optional later)  
- AI planner  
- Full parity with GAS reactive maintenance — separate track  

---

## Compass alignment

- **Signal** → portal POST or future staff command (normalized).  
- **Decision + persistence** → V2 program engine + DAL (not tenant core).  
- **User-visible** confirmations → Outgate when you add messaging later; V1 can be API-only + app UI.

---

## Related docs

- Cursor plan (broader PM vision): `.cursor/plans/preventive_maintenance_pm_fit_*.plan.md`  
- Parity / reactive maintenance: `docs/PARITY_LEDGER.md` (do not conflate with this V1 scope)
