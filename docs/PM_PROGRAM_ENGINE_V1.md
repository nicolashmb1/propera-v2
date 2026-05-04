# Preventive / Tasks Engine — V1 (locked definition)

**Status:** **Shipped baseline** — V2 portal routes + DAL + expansion; **propera-app** `/preventive` (feature-flagged) with preview, optional scope subset on create, property building-structure edit. **Not** scheduling, tenant SMS outreach, or AI planning.

---

## Purpose

One engine handles HVAC, painting, water heater, gutters, cleaning, etc. — **not** separate products per service.

**Anchor:** `Program Run` (parent) + `Program Lines` (checklist).  
**Separation:** This path is **not** reactive tenant maintenance tickets. Tenant intake (`handleInboundCore`, finalize ticket flow) must **not** own program creation.

---

## Core idea

| Input | Example |
|--------|---------|
| Property + template + optional **subset of expanded scope labels** | “Start painting for Morris — only 1st floor + Gym this quarter” |

**Output:**

- One **program run**: e.g. “Murray — HVAC Maintenance”
- Many **lines**: Unit 101 Open, Unit 102 Open, …, plus common scopes (or one **Common Area**) — staff mark each complete.

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
| `UNIT_PLUS_COMMON` | HVAC, water heater, filters, smoke detectors | Active units from roster + **`common_paint_scopes`** as **COMMON_AREA** lines when set on the property; else one **“Common Area”** line |
| `FLOOR_BASED` | Painting, hallway cleaning, floor inspections | Floors from `program_expansion_profile.floor_paint_scopes`, then **common-area scopes** from `common_paint_scopes` (same card as Properties → building structure), then template defaults |
| `COMMON_AREA_ONLY` | Lobby repair, exterior lights, boiler room | Common-area lines only (`scope_type` **`COMMON_AREA`**) |
| `CUSTOM_MANUAL` | One-offs | Minimal or empty initial lines; staff add lines later (later phase) |

**Pattern:** `template_key` → `expansion_type` → **deterministic line generator** (no per-service hardcoding in core logic).

---

## Smart creation (`createProgramRun`)

**Inputs:** JSON with **`templateKey`**, **`createdBy`**, and either **`propertyCode`** or **`property`** (display name). Optional **`includedScopeLabels`**: string[] of **`scope_label`** values to keep after expansion. If omitted or empty, **all** expanded lines are inserted (backward compatible). If non-empty and **no** expanded line matches, create fails with **`no_matching_scopes`**.

**Flow:**

1. Resolve property name/code → `property_code`; load `properties.program_expansion_profile` (jsonb).
2. Load `program_templates` row for `template_key`.
3. **`expandProgramLines(template, unitRows, { expansionProfile })`** — pure function; no DB.
   - **UNIT_PLUS_COMMON:** active roster units + one line per **`common_paint_scopes`** entry (building structure); if that list is empty, a single **“Common Area”** line.
   - **FLOOR_BASED:** floors from **`floor_paint_scopes`** (else template `default_scope_labels`, else built-in defaults), then **append** **`common_paint_scopes`** as lines with `scope_type` **`COMMON_AREA`** (same labels as Properties → **Building structure**).
   - **COMMON_AREA_ONLY:** **`common_paint_scopes`** only (else defaults).
   - **CUSTOM_MANUAL:** no lines at create.
4. If **`includedScopeLabels`** is non-empty, filter expanded specs to those whose trimmed **`scope_label`** is in the set; renumber **`sort_order`**. Empty result → **`no_matching_scopes`**.
5. Insert one `program_runs` row + N `program_lines` in one transaction.
6. Return the new run and lines.

**HVAC example:** Murray → Unit 101, Unit 102, …, then **Gym** / **Lobby** (or **Common Area**) when `common_paint_scopes` is set (roster + building structure).  
**Painting example:** Morris → 1st–4th floor lines (`FLOOR`) + Gym, Lobby (`COMMON_AREA`) when saved on the property; portal/app may send **`includedScopeLabels`** to create a subset only.

## Preview (`previewProgramRunExpansion`)

**Purpose:** Same expansion as create, **no writes** — for UI checklist preview.

**Portal:** `POST /api/portal/program-runs/preview` with body like `{ "templateKey": "COMMON_AREA_PAINT", "propertyCode": "MORRIS" }` (or `"property": "Morris"`) → `{ ok, lines: [{ scope_type, scope_label, sort_order }], expansion_type, template_key, property_code }`.

---

## Boundary (critical)

| This engine | Not this |
|-------------|----------|
| Owner / PM / staff starts an **operational program** | Tenant says “sink is leaking” → reactive ticket |
| Controlled checklist in Postgres | Tenant intake merge / `finalizeMaintenance` as the creator |

V1 **entry points:**

1. **propera-app** `/preventive`: property + template → **preview** → **checkboxes per distinct `scope_label`** → **Create program run** (optional **`includedScopeLabels`**). List runs, open checklist panel, complete/reopen lines; **delete run** (role-gated) where implemented.
2. **Later:** staff natural language — same `createProgramRun` (or thin wrapper) underneath.

App and staff lane **must** call the **same** V2 DAL / expansion logic.

---

## propera-app API (V1)

propera-app **does not** write DB directly. It calls V2; V2 validates, persists, logs (`event_log` as appropriate).

**Base path:** `/api/portal/…` (same auth as other portal routes).

| Need | Method | Path |
|------|--------|------|
| List templates (dropdown) | GET | `/api/portal/program-templates` |
| List runs | GET | `/api/portal/program-runs` |
| One run + lines | GET | `/api/portal/program-runs/:id` |
| Preview expansion (no DB) | POST | `/api/portal/program-runs/preview` |
| Start program | POST | `/api/portal/program-runs` |
| Delete run + lines | DELETE | `/api/portal/program-runs/:id` |
| Mark line complete | PATCH | `/api/portal/program-lines/:id/complete` |
| Reopen line | PATCH | `/api/portal/program-lines/:id/reopen` |

**POST body (create):** `{ "propertyCode": "MORRIS", "templateKey": "COMMON_AREA_PAINT", "createdBy": "PORTAL", "includedScopeLabels": ["1st floor", "Gym"] }` — `includedScopeLabels` optional; `property` (display name) allowed instead of `propertyCode`.

**POST body (preview):** `{ "propertyCode": "MORRIS", "templateKey": "COMMON_AREA_PAINT" }` (or `property`).

**PATCH complete body:** `{ "completedBy": "STAFF_NICK", "notes": "" }` (optional).

Auth: same portal token pattern as existing portal routes (`X-Propera-Portal-Token` / `PROPERA_PORTAL_TOKEN`).

**Migrations:** `supabase/migrations/018_program_engine_v1.sql` (program tables), **`019_properties_program_expansion_profile.sql`** (`properties.program_expansion_profile` — optional per-property `floor_paint_scopes` / `common_paint_scopes` arrays for line expansion).

---

## propera-app UI (V1)

**Feature flag:** `NEXT_PUBLIC_PROPERA_PREVENTIVE_ENABLED=1` shows nav **Preventive** and wires API proxies (`PROPERA_V2_API_URL` + `PROPERA_PORTAL_TOKEN`).

**Route:** `/preventive`. Next routes proxy to V2: `/api/program-templates`, `/api/program-runs` (GET/POST), `/api/program-runs/preview` (POST), `/api/program-runs/[id]` (GET/DELETE), `/api/program-lines/[id]/complete`, `/api/program-lines/[id]/reopen`.

**Property building structure:** `/properties/[propertyKey]` — **Preventive · Building structure**: edit **`floor_paint_scopes`** and **`common_paint_scopes`**; PATCH merges **`program_expansion_profile`** on the property (V2). Link from Preventive (“Property structure”) and optional `?propertyCode=` preset when opening Preventive from a property.

**Preventive page:**

- Start program: property + template selectors; template cards with expansion-type hints.
- **Preview checklist** (computed lines) when both are chosen.
- **Areas in this run:** one checkbox per distinct **`scope_label`** from preview (default all on); **Select all / Clear all**.
- **Create program run** sends **`includedScopeLabels`** when the preview had lines and at least one area remains checked.
- Main column scrolls as a single **`page-scroll`** region (header through run list) so long previews and area lists are not clipped.
- **Filter runs** by property; run cards open right **checklist** panel (complete/reopen per line).
- **Delete program run** from list or panel where portal role allows (V2 + app gate).

---

## Implementation checklist (V1 slice — done vs later)

| Step | Status |
|------|--------|
| Schema `018` + seed templates; **`019`** `program_expansion_profile` | Done |
| **`expandProgramLines`** + **`createProgramRun`** / list / detail / preview / delete / line PATCH | Done |
| Portal routes + **`includedScopeLabels`** on create | Done |
| **propera-app** `/preventive` + proxies + property profile PATCH | Done |
| Staff NL → `createProgramRun` | Later |

---

## Strategic reuse — building structure beyond preventive (roadmap)

**What exists today:** `properties.program_expansion_profile` (JSON: **`floor_paint_scopes`**, **`common_paint_scopes`**) is the **per-property building model** maintained once in the owner portal (**Preventive · Building structure**). It feeds **`expandProgramLines`** for **program runs** (preview, optional **`includedScopeLabels`** on create) and keeps preventive checklists aligned with the real building.

**Product direction (partially or not yet wired in code):** the same structured scopes are intended to **assist other flows** without duplicating ad-hoc property lists:

| Flow | How structure helps |
|------|---------------------|
| **Operational / PM** | More templates and work types read the same profile; staff pick known zones instead of retyping. |
| **Tenant / intake** | Messages like “damaged furniture on the terrace at Morris” can resolve to a **canonical scope** (title, routing, dedupe) when the property defines **Terrace** (or **Gym**, **Lobby**, etc.) as a common scope. |
| **Staff capture (`#`, portal, adapters)** | Suggested or constrained **location** controls reduce ambiguous tickets and speed finalize when text matches a configured label. |
| **Analytics / reporting** | Consistent labels across tickets and programs when both consume the same source of truth. |

**Engineering guardrails:** new consumers should **load and match** this profile via shared, testable helpers (property context + normalized label matching). **Do not** conflate reactive ticket creation with **`createProgramRun`** (see **Boundary** above). **Do not** let tenant core **`handleInboundCore`** own program-run creation. Intake improvements stay **read-side enrichment** or **post-parse resolution** until an explicit design moves ownership in **North Compass** / guardrails.

---

## Out of scope for V1

- Scheduling / cron / “10 per day” tenant outreach  
- Tenant SMS for access (optional later)  
- AI planner  
- Full parity with GAS reactive maintenance — separate track  

---

## Planned after V1 acceptance (V1.2-style): “Request access” on program lines

**Gate:** Start this slice only after **V1 PM** is stable in product: template construction, preventive layout, checklist workflow (`program_runs` / `program_lines` + app), and operators are happy with the flow. **propera-app** product note: **`PROPERA_APP_MARKET_ENTRY_PLAN.md`** §8.

**Problem:** Runs like **HVAC filter** expand to one **`program_line` per unit** (plus common lines). Staff often need **permission or a scheduled time** before entering a unit.

**Planned behavior (middle agent, not full autonomy):**

| Piece | Intent |
|-------|--------|
| **UI** | Per line (e.g. each **UNIT** row in the checklist panel), an action **Request access** alongside **Complete** / **Reopen**. |
| **Outbound** | Propera sends a message (channel TBD — SMS / WhatsApp / etc.) asking the tenant for **a time window** or **permission to enter**. |
| **Inbound** | Tenant reply is received through the normal messaging path where applicable. |
| **Persistence** | Parsed outcome is **stored on the child** — the same **`program_line`** (new columns) or a **small child row** keyed by `program_line_id` — so the row shows e.g. *access requested → “OK after 2pm Tue”* without conflating with unrelated ticket rows unless a later design explicitly merges them. |

**Engineering notes when picked up:**

- Schema: e.g. `access_request_status`, `access_window_text`, `access_replied_at`, or a dedicated `program_line_access_events` table — decide in migration + DAL; keep **portal + `event_log`** auditable.  
- **Outgate** sends the ask; **brain / intake** must not silently auto-complete program lines from tenant SMS without an explicit policy (North Compass: *who owns the next action?*).  
- Stay consistent with **Boundary** above: program completion remains staff-driven unless product explicitly adds tenant-confirm flows with clear ownership.

---

## Planned evolution: user-defined programs (“structure + name”, not global product templates)

**Intent (product):** Stop treating **HVAC_PM** / **COMMON_AREA_PAINT**–style rows as the primary UX. Operators want to **choose property → pick structure kind** (same `expansion_type` vocabulary today: *Units + common*, *Floors / zones*, *Common areas only*, *Manual*) **→ align with that property’s building structure** (`program_expansion_profile`) **→ name the program** (e.g. “HVAC Maintenance”, “Carpet Cleaning”) **→ save** so it can be **re-run** the same way later. “Template” becomes **structure + saved program definition**, not a fixed global catalog.

**Contrast with V1 today:**

| Today (V1) | Target direction |
|------------|-------------------|
| Global **`program_templates`** rows (seed keys) + `program_runs.template_key` FK | **Saved program definitions** per property (or org): `expansion_type` + **user label** + optional scope subset / overrides; runs reference **that definition** (new id) or a stable generated key namespaced per property |
| Label implies product (“HVAC Maintenance”) in seed data | **User-chosen display name** at save time; reuse is “start another run from this saved program” |
| Template dropdown = fixed list | **Create program** flow: structure picker + property structure + name + save; library = **my programs for this property** |

**Engineering when picked up (sketch, not final):**

- New table (e.g. **`program_definitions`** or **`saved_programs`**) with at least: `id`, `property_code`, `display_name`, `expansion_type`, optional `default_scope_labels` / flags for which profile slices to include, `created_by`, timestamps — **or** relax `program_templates` to allow **inserted** rows with keys like `PROP:{code}:{slug}` and property ownership metadata (weaker normalization).  
- **`program_runs`**: either FK to definition id + snapshot expansion at run time, or keep `template_key` but populate `program_templates` dynamically per save (trade-offs: FK churn vs clarity).  
- **Portal + app:** CRUD for definitions; create run = pick **saved program** (or duplicate wizard); preview still uses **`expandProgramLines`** with profile + definition.  
- **Migration / seed:** existing seeds become **defaults** or **examples**, not the only path.

**Gate:** Spec and schema first after V1 checklist + mobile flows are accepted; avoid parallel “half global, half custom” without a migration story.

---

## Compass alignment

- **Signal** → portal POST or future staff command (normalized).  
- **Decision + persistence** → V2 program engine + DAL (not tenant core).  
- **User-visible** confirmations → Outgate when you add messaging later; V1 can be API-only + app UI.  
- **Building structure** → one canonical profile per property; **today** drives PM expansion; **tomorrow** assists resolver/intake (see **Strategic reuse**) without merging program creation into tenant core.

---

## Related docs

- Cursor plan (broader PM vision): `.cursor/plans/preventive_maintenance_pm_fit_*.plan.md`  
- Parity / reactive maintenance: `docs/PARITY_LEDGER.md` (do not conflate with this V1 scope)  
- File map (where portal PM code lives vs inbound brain): `docs/BRAIN_PORT_MAP.md` — **Portal: preventive / program runs**  
- App market-entry backlog (same “Request access” intent): **`propera-app/PROPERA_APP_MARKET_ENTRY_PLAN.md`** §8  
- **User-defined programs (structure + name):** this doc, **Planned evolution** section above
