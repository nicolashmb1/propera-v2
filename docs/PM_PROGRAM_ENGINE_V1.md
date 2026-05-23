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
| Property + **legacy** `templateKey` + optional **subset of expanded scope labels** | “Start painting for Morris — only 1st floor + Gym this quarter” |
| Property + **saved program** (`savedProgramId`) + optional **`includedScopeLabels`** | Re-run “Gutter Maintenance” for Morris with default or overridden scopes |
| Property + **`expansionType`** (preview only) + optional **`includedScopeLabels`** | Ephemeral checklist preview before saving a definition |

**Output:**

- One **program run**: e.g. “Murray — HVAC Maintenance”
- Many **lines**: Unit 101 Open, Unit 102 Open, …, plus common scopes (or one **Common Area**) — staff mark each complete.

**Expansion engine** (`expansion_type` on a global template row or on a **saved program**) defines **how lines expand** (units vs floors vs common-only). The **display name** is a label only (template `label`, or `saved_programs.display_name`).

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

### `saved_programs` (property-scoped definitions)

| Field | Notes |
|-------|--------|
| `id` | uuid PK |
| `property_code` | FK → `properties.code` |
| `display_name` | Operator label (“Carpet Cleaning”, …) |
| `expansion_type` | Same four engines as templates |
| `default_included_scope_labels` | jsonb optional — default subset of `scope_label` values when starting a run without explicit **`includedScopeLabels`** |
| `active` / `archived_at` | Soft-delete: archive hides from library; historical runs keep `saved_program_id` |

### `program_runs`

One active program/task per row. **Strict XOR:** exactly one of **`template_key`** (legacy global template) or **`saved_program_id`** (saved program definition).

| Field | Example |
|-------|---------|
| `id` | uuid |
| `property_code` | `MURRAY` |
| `template_key` | `HVAC_PM` **or** `null` when using a saved program |
| `saved_program_id` | uuid **or** `null` when using a legacy template |
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
| `proof_photo_urls` | jsonb array of public image URLs (set on complete; cleared on reopen) |

---

## Expansion types → line generators

| expansion_type | Used for | Line generation |
|----------------|----------|-----------------|
| `UNIT_PLUS_COMMON` | HVAC, water heater, filters, smoke detectors | Active units from roster + **common-area labels** merged from **`program_expansion_profile.common_paint_scopes`** and active **`property_locations`** (`kind = common_area`); else one **“Common Area”** line |
| `FLOOR_BASED` | Painting, hallway cleaning, floor inspections | Floors from `program_expansion_profile.floor_paint_scopes`, then **common-area labels** (profile + **`property_locations`**, same merge as above), then template defaults |
| `COMMON_AREA_ONLY` | Lobby repair, exterior lights, boiler room | Common-area lines only (`scope_type` **`COMMON_AREA`**) from the same merged label list |
| `CUSTOM_MANUAL` | One-offs | No lines at create; staff **add lines** via portal (`POST …/lines`) |

**Pattern:** resolve **definition** (legacy `program_templates` row **or** `saved_programs` row **or** ephemeral preview shape) → `expansion_type` → **`expandProgramLines`** (no second expansion implementation).

---

## Smart creation (`createProgramRun`)

**Inputs:** exactly one of **`templateKey`** or **`savedProgramId`**; **`createdBy`**; either **`propertyCode`** or **`property`** (display name). Optional **`includedScopeLabels`**: string[] of **`scope_label`** values to keep after expansion.

**Filter merge order:** if **`includedScopeLabels`** is non-empty, filter expanded lines to that set. Else if the definition has **default included labels** (saved program `default_included_scope_labels` or template `default_scope_labels`), filter to that set. Else keep **all** expanded lines. Empty filter result → **`no_matching_scopes`**.

**Saved program runs** require the saved row **`active = true`** and matching **`property_code`**.

**Flow:**

1. Resolve property name/code → `property_code`; load `properties.program_expansion_profile` (jsonb).
2. Resolve definition: load **`program_templates`** for **`templateKey`**, or **`saved_programs`** for **`savedProgramId`** (with property match + active check).
3. **`expandProgramLines(template, unitRows, { expansionProfile })`** — pure function; no DB.
   - **UNIT_PLUS_COMMON:** active roster units + one line per **`common_paint_scopes`** entry (building structure); if that list is empty, a single **“Common Area”** line.
   - **FLOOR_BASED:** floors from **`floor_paint_scopes`** (else template `default_scope_labels`, else built-in defaults), then **append** **`common_paint_scopes`** as lines with `scope_type` **`COMMON_AREA`** (same labels as Properties → **Building structure**).
   - **COMMON_AREA_ONLY:** **`common_paint_scopes`** only (else defaults).
   - **CUSTOM_MANUAL:** no lines at create.
4. Apply **filter merge order** above; renumber **`sort_order`**. Empty result → **`no_matching_scopes`**.
5. Insert one `program_runs` row + N `program_lines` in one transaction.
6. Return the new run and lines.

**HVAC example:** Murray → Unit 101, Unit 102, …, then **Gym** / **Lobby** (or **Common Area**) when `common_paint_scopes` is set (roster + building structure).  
**Painting example:** Morris → 1st–4th floor lines (`FLOOR`) + Gym, Lobby (`COMMON_AREA`) when saved on the property; portal/app may send **`includedScopeLabels`** to create a subset only.

## Preview (`previewProgramRunExpansion`)

**Purpose:** Same expansion as create, **no writes** — for UI checklist preview.

**Portal:** `POST /api/portal/program-runs/preview` with **exactly one** of:

- Legacy: `{ "templateKey": "COMMON_AREA_PAINT", "propertyCode": "MORRIS" }`
- Saved: `{ "savedProgramId": "<uuid>", "propertyCode": "MORRIS" }`
- Ephemeral (before a saved row exists): `{ "propertyCode": "MORR", "expansionType": "COMMON_AREA_ONLY", "includedScopeLabels": ["Roof", "Exterior"] }`

Response includes `lines`, `expansion_type`, `property_code`, and `template_key` / `saved_program_id` when applicable (both null for ephemeral).

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
| List saved programs (active) for property | GET | `/api/portal/saved-programs?propertyCode=` |
| Create saved program | POST | `/api/portal/saved-programs` |
| Archive saved program | DELETE | `/api/portal/saved-programs/:id` |
| List runs | GET | `/api/portal/program-runs` |
| One run + lines | GET | `/api/portal/program-runs/:id` |
| Preview expansion (no DB) | POST | `/api/portal/program-runs/preview` |
| Start program | POST | `/api/portal/program-runs` |
| Delete run + lines | DELETE | `/api/portal/program-runs/:id` |
| **Add checklist line** | POST | `/api/portal/program-runs/:id/lines` — body `{ scopeType, scopeLabel, sortOrder? }`. When the property has building structure (roster units + `program_expansion_profile` + `property_locations`), labels must match that list unless **`scopeType` is `SITE`** (custom one-off). Portal UI uses a structure picker + **Custom (other)**. |
| **Create ticket from line** | POST | `/api/portal/program-lines/:id/create-ticket` — body `{ issueText, category?, urgency? }`; **`finalizeMaintenanceDraft`** (not `handleInboundCore`); sets `program_lines.linked_ticket_*` + `tickets.program_*`. Requires migration **`060`**. propera-app proxies with session Bearer JWT. |
| **Remove checklist line** | DELETE | `/api/portal/program-lines/:id` (line row only, not the run) |
| **Reorder lines** | PATCH | `/api/portal/program-runs/:id/lines/reorder` — body `{ lineIds: uuid[] }` full permutation |
| List runs (filtered) | GET | `/api/portal/program-runs?propertyCode=&status=&inProgress=true` |
| Mark line complete | PATCH | `/api/portal/program-lines/:id/complete` |
| Reopen line | PATCH | `/api/portal/program-lines/:id/reopen` |

**POST body (create):** either  
`{ "propertyCode": "MORRIS", "templateKey": "COMMON_AREA_PAINT", "createdBy": "PORTAL", "includedScopeLabels": ["1st floor", "Gym"] }`  
or  
`{ "propertyCode": "MORRIS", "savedProgramId": "<uuid>", "createdBy": "PORTAL", "includedScopeLabels": [] }` — **`includedScopeLabels`** optional; `property` (display name) allowed instead of `propertyCode`.

**POST body (saved program):** `{ "propertyCode": "MORR", "displayName": "Gutter Maintenance", "expansionType": "COMMON_AREA_ONLY", "defaultIncludedScopeLabels": ["Roof", "Exterior"] }` — **`defaultIncludedScopeLabels`** optional.

**POST body (preview):** one of templateKey / savedProgramId / expansionType bodies above; optional **`includedScopeLabels`**.

**PATCH complete body:** `{ "completedBy": "STAFF_NICK", "notes": "", "proofPhotoUrls": ["https://…"] }` — **`notes`** / **`proofPhotoUrls`** optional. **`notes`** (max **2000** chars) is shown on completed lines in **propera-app** `/preventive`. **`proofPhotoUrls`** is an array of public **http(s)** image URLs (max **12**); staff uploads images via **propera-app** (same **`pm-attachments`** storage as ticket photos), then sends URLs on complete. Reopening a line clears **`notes`** and **`proof_photo_urls`**.

Auth: same portal token pattern as existing portal routes (`X-Propera-Portal-Token` / `PROPERA_PORTAL_TOKEN`).

**Migrations:** `supabase/migrations/018_program_engine_v1.sql` (program tables), **`019_properties_program_expansion_profile.sql`** (`properties.program_expansion_profile` — optional per-property `floor_paint_scopes` / `common_paint_scopes` arrays for line expansion), **`022_saved_programs.sql`** (`saved_programs`, `program_runs.saved_program_id`, strict XOR on runs), **`040_program_lines_proof_photos.sql`** (`program_lines.proof_photo_urls` jsonb — proof-of-work image URLs on complete).

---

## propera-app UI (V1)

**Feature flag:** `NEXT_PUBLIC_PROPERA_PREVENTIVE_ENABLED=1` shows nav **Preventive** and wires API proxies (`PROPERA_V2_API_URL` + `PROPERA_PORTAL_TOKEN`).

**Route:** `/preventive`. Next routes proxy to V2: `/api/program-templates`, `/api/saved-programs`, `/api/program-runs` (GET/POST), `/api/program-runs/preview` (POST), `/api/program-runs/[id]` (GET/DELETE), `/api/program-lines/[id]/complete`, `/api/program-lines/[id]/reopen`.

**Property building structure:** `/properties/[propertyKey]` — **Preventive · Building structure**: edit **`floor_paint_scopes`** and **`common_paint_scopes`**; PATCH merges **`program_expansion_profile`** on the property (V2). Link from Preventive (“Property structure”) and optional `?propertyCode=` preset when opening Preventive from a property.

**Preventive page:**

- Start program: property + **structure type** cards + program name; ephemeral preview; **create** persists **`saved_programs`** then **`program_runs`** with **`savedProgramId`** (Option A). Legacy **`templateKey`** runs remain supported in the API.
- **Preview checklist** (computed lines) when both are chosen.
- **Areas in this run:** one checkbox per distinct **`scope_label`** from preview (default all on); **Select all / Clear all**.
- **Create program run** sends **`includedScopeLabels`** when the preview had lines and at least one area remains checked.
- Main column scrolls as a single **`page-scroll`** region (header through run list) so long previews and area lists are not clipped.
- **Filter runs** by property; **Saved programs** strip (desktop) lists active definitions with **Start run**; run cards open right **checklist** panel (complete/reopen per line; **completed_at** / **completed_by** on lines).
- **Vendor per line (2026-05-18):** optional **`assigned_vendor_id`** / display snapshot on `program_lines`; portal **`PATCH /api/portal/program-lines/:id/vendor`**; propera-app `/preventive` vendor dropdown (requires **`vendors`** table — migration **046**).
- **Completion notes:** optional textarea per open line; persisted on complete and shown on completed lines (reopen clears).
- **Proof of work:** optional photos per open line (upload to **`pm-attachments`**, then stored on complete as **`proof_photo_urls`**); thumbnails on completed lines; reopen clears photos. **Mobile:** file input must stay focusable (avoid `display:none` only); accept images when **`file.type` is empty** but extension looks like a photo (iOS camera roll).
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
| **`saved_programs` + XOR `program_runs` + preview ephemeral + app proxies** | Done (`022_saved_programs.sql`, DAL, portal, propera-app) |
| **Line completion proof photos** | Done (`040_program_lines_proof_photos.sql`, DAL + portal + **`/preventive`**) |
| **Per-line vendor assignment** | Done (`046_vendors_and_program_line_vendor.sql`, `setProgramLineVendor`, portal PATCH, **`/preventive`**) |
| **Mutable lines (add / remove / reorder)** | Done — portal routes + **`/preventive`** UI (`059` not required for lines; uses existing `program_lines`) |
| **Program Activity timeline** | Done — `059_program_timeline_v1.sql`, `program_timeline_events`, DAL writers on run/line mutations |
| **Run list filters** | Done — `listProgramRuns({ propertyCode, status, inProgress })` + app filter chips |

---

## Strategic reuse — building structure beyond preventive (roadmap)

**What exists today:** `properties.program_expansion_profile` (JSON: **`floor_paint_scopes`**, **`common_paint_scopes`**) is edited in the owner portal (**Preventive · Building structure**). Saving **`common_paint_scopes`** syncs rows in **`property_locations`** (`kind = common_area`). **`expandProgramLines`** merges profile labels with active **`property_locations`** on preview/create so preventive checklists match ticket/access location labels even when profile JSON was empty or stale.

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

## User-defined programs (shipped)

Property-scoped **`saved_programs`** hold **`display_name`** + **`expansion_type`** + optional **`default_included_scope_labels`**. **`program_runs`** use **strict XOR**: legacy **`template_key`** **or** **`saved_program_id`**. Archive = **`active`** / **`archived_at`** (DELETE on portal is logical archive). **`program_lines`** remain the operational truth per child (stable ids); scheduling / access fields are future columns on lines or child tables.

**Durable spine (query / memory later):** Property → Saved program → Run → Lines (`status`, **`completed_at`**, **`completed_by`**, …).

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
- **User-defined programs:** this doc, **User-defined programs (shipped)** section above
