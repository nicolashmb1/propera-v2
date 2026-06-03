# Tenant portal — bilingual UI (en / es)

**Purpose:** Build spec for **resident portal** language support in `propera-app` (`/tenant/*`) + **`propera-v2` `/api/tenant/*`**. Staff portal (`/`, `/access`, etc.) is **out of scope** — do not change staff UI or staff routes for this program.

**Status:** **Phases 1–3 live** + **Phase 4 partial** (push prompt localized, HANDOFF_LOG). Login + amenity display translate deferred.

**Related:** [TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md) · [AGENTS.md](../AGENTS.md) · [PROPERA_GUARDRAILS.md](../../propera-gas-reference/PROPERA_GUARDRAILS.md) · [TICKET_TIMELINE.md](./TICKET_TIMELINE.md) · [COMMUNICATION_ENGINE.md](./COMMUNICATION_ENGINE.md) (staff outbound `language` — separate from this doc)

**Repos:** `propera-v2` (profile, translate-on-write, translate-on-read APIs) · `propera-app` (static UI copy, profile picker, locale formatting)

---

## Locked product decisions

| # | Decision | Meaning |
|---|----------|---------|
| **1** | **Translate for display** | When the tenant’s UI language is `es`, **dynamic** text from the DB (ticket description, service notes shown to tenant, notice body, timeline headlines, amenity descriptions if needed) is **translated at read time** for the portal response. Canonical DB text stays as stored. |
| **2** | **English only (operational)** | **Brain, tickets, and staff surfaces** use **English** as the canonical operational language. Portal **writes** translate tenant Spanish → English **before** `create_ticket`. Staff portal continues to read **English** rows; no staff i18n in this program. |
| **3** | **en + es first** | Ship **`en`** and **`es`** only. `tenant_roster.preferred_language` allows `pt` in schema; **ignore `pt` in UI** until a later phase (treat as `en` for display). |
| **4** | **Profile + detect** | **Primary:** `preferred_language` on profile. **Secondary:** **language detection** on free text (maintenance description on create; optional detect-on-read for display when profile is `en` but content is clearly Spanish — see §Language resolution). |

---

## Principles (architecture)

1. **Tenant portal adapter only** — JWT routes under `/api/tenant/*`; no changes to `handleInboundCore`, resolver, or SMS/Telegram tenant-agent paths unless explicitly scheduled later.
2. **Expression layer, not control layer** — Translation and static i18n are **presentation**. They must not alter lifecycle decisions, dedupe, or stage resolution.
3. **English in, English stored** — After translate-on-write, `tickets.message_raw` (and fields sent to `runInboundPipeline`) are **English** for portal-created maintenance.
4. **Display is derived** — Spanish UI does not require Spanish rows in `tickets` / `communication_recipients`; V2 returns **display fields** (or a parallel `display.*` object) translated for the tenant locale.
5. **Staff portal untouched** — No nav, copy, or route changes outside `/tenant/*` and tenant proxies.

---

## Language resolution

### Effective UI locale (portal chrome)

```text
uiLocale = normalize(preferred_language)  // en | es; pt → en for v1
```

Loaded from `GET /api/tenant/me` → `tenant.preferredLanguage` → `TenantBrandContext`.

### Effective content locale (free text)

Used on **create** and optional **read** paths:

```text
contentLocale = detectLanguage(text)     // en | es | unknown
effectiveWriteLocale = contentLocale !== "unknown" ? contentLocale : uiLocale
```

**On maintenance create:**

- If `effectiveWriteLocale === "es"` → translate description (and optional location detail) **to English** before `runInboundPipeline`.
- If already English → pass through.
- **Categories** remain **stable English keys** in the payload (see §Categories).

**On read (display):**

- If `uiLocale === "es"` and stored text is detected or known as English → translate to Spanish for the tenant API response.
- If `uiLocale === "en"` and stored text is Spanish (legacy row or detect) → translate to English for display (edge case).
- If text already matches `uiLocale`, skip translation.

### Detection (v1 recommendation)

| Use | Approach |
|-----|----------|
| **Create** (description ≥ 20 chars) | Small deterministic + LLM fallback: `src/tenant/detectTextLanguage.js` — prefer fast heuristic (`franc-min` or char-ratio) with optional single-shot LLM when confidence low. |
| **Read** (optional) | Same detector on `message_raw` / `messageBody` when `uiLocale !==` detected language. |
| **Never** | Do not run detection inside brain/core or adapters. |

Log `detected_locale` + `translation_applied` on tenant routes (structured log / `event_log` tenant channel) for debugging — no PII in logs beyond trace id.

---

## Data model (no new migration required for MVP)

| Field | Table | Role |
|-------|-------|------|
| `preferred_language` | `tenant_roster` | `en` \| `es` (portal UI + default assume for content) — **already in `056`** |
| `message_raw`, `service_notes`, … | `tickets` | **English** after portal create (translate-on-write) |
| `message_body` | `communication_campaigns` / recipient join | Staff-authored; **translate for display** when tenant `uiLocale === es` |
| Timeline `headline` | `ticket_timeline_events` | Translate for display if English and tenant `es` |

**Optional phase 2 column (not MVP):** `tickets.tenant_message_original` text — retain resident Spanish verbatim for audit. **Not required** for decisions 1–2 if write path always normalizes to English before store.

---

## System map

```text
┌─────────────────────────────────────────────────────────────────┐
│ propera-app /tenant/* (static i18n: nav, labels, errors)       │
│   preferredLanguage ← /api/tenant/me                            │
└────────────────────────────┬────────────────────────────────────┘
                             │ /api/tenant/* proxies
┌────────────────────────────▼────────────────────────────────────┐
│ propera-v2 /api/tenant/*                                        │
│   profile PATCH → preferred_language                            │
│   maintenance POST → detect → translate→EN → create_ticket      │
│   maintenance GET  → map ticket → translateForDisplay(es)     │
│   notices GET      → translate messageBody for display          │
│   (amenities)      → static UI i18n; names/descriptions TBD     │
└────────────────────────────┬────────────────────────────────────┘
                             │ English payload only
┌────────────────────────────▼────────────────────────────────────┐
│ runInboundPipeline / tickets / brain (unchanged semantics)        │
│ Staff portal reads English tickets (no change)                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scope by surface

### In scope (tenant portal)

| Surface | Static UI (app) | Dynamic DB text (V2 display translate) |
|---------|-----------------|----------------------------------------|
| Shell nav, dashboard, login | ✅ | — |
| Profile + language picker | ✅ | — |
| Maintenance list / new / detail | ✅ labels, categories, statuses | ✅ description, service notes (tenant-visible), timeline headlines |
| Amenities (if visible) | ✅ | Optional: `description` on location |
| Notices list / detail | ✅ comm type labels | ✅ `messageBody` |
| Documents | ✅ chrome only | — (filenames as stored) |
| Balance / lease placeholders | ✅ | — |
| OTP SMS | ❌ v1 — stays English | — |
| PWA push prompt | ✅ | — |

### Out of scope (this program)

| Item | Note |
|------|------|
| Staff portal (`propera-app` non-tenant) | Explicitly excluded |
| Tenant Agent SMS / WhatsApp / Telegram | Separate program; may reuse `detectTextLanguage` later |
| Voice / Max | English operational; no change here |
| Portuguese UI | Schema allows `pt`; v1 maps to `en` |
| Translating staff-authored **outbound** campaign compose | Staff comm engine already has `language` for sends |

---

## API contract changes

### `PATCH /api/tenant/profile`

**Body (add):**

```json
{ "email": "...", "preferredLanguage": "en" }
```

- Validate: `en` \| `es` only (reject `pt` with 400 or coerce to `en` — pick one in implementation; doc recommends **reject** with clear error).
- Return full session shape from `loadTenantSessionBrand` (includes `tenant.preferredLanguage`).

**Today:** email only — extend `tenantProfileService.js`.

### `GET /api/tenant/me`

No shape break. Ensure `tenant.preferredLanguage` is always present.

### `POST /api/tenant/maintenance`

**Before** `createTenantMaintenanceTicket`:

1. `detectLanguage(description)` (+ `location` if present).
2. If non-English → `translateToEnglish({ text, sourceLocale })`.
3. Pipeline receives English `description` / `message`.

**Response:** unchanged; optional `meta: { detectedLocale, translated: true }` for debugging (non-breaking).

### `GET /api/tenant/maintenance`, `GET /api/tenant/maintenance/:id`

For each tenant-visible string field, apply `translateForDisplay(text, { targetLocale: uiLocale })` when detector says source ≠ target.

Suggested response shape (backward compatible):

```json
{
  "ok": true,
  "ticket": {
    "description": "…",
    "descriptionDisplay": "…",
    "title": "…",
    "titleDisplay": "…",
    "serviceNotes": "…",
    "serviceNotesDisplay": "…",
    "timeline": [{ "action": "…", "actionDisplay": "…", "by": "…", "time": "…" }]
  }
}
```

**App rule:** Prefer `*Display` when `uiLocale === "es"`, else canonical field (or always use `*Display` when present).

### `GET /api/tenant/notices`

Translate `messageBody` → `messageBodyDisplay` (and `title` if shown) when `uiLocale === "es"`.

### Categories (maintenance create)

| Layer | Value |
|-------|--------|
| **API / brain** | Stable English snake or Pascal keys: `Plumbing`, `HVAC`, … (today’s list) |
| **App UI** | Map key → localized label (`CATEGORIES` → `t("category.plumbing")`) |
| **Review step** | Show localized label; submit English key |

Do not send Spanish category strings into `create_ticket`.

---

## V2 modules (new / extended)

| Module | Responsibility |
|--------|----------------|
| `src/tenant/detectTextLanguage.js` | `detectLanguage(text) → en \| es \| unknown` |
| `src/tenant/translateTenantText.js` | `translateToEnglish`, `translateForDisplay` — LLM or shared translator util; env-gated |
| `src/tenant/tenantProfileService.js` | `preferredLanguage` PATCH |
| `src/tenant/tenantMaintenanceService.js` | Wire write translate + read display |
| `src/tenant/tenantNoticesService.js` | Display translate on notice bodies |
| `src/tenant/tenantBrandResolve.js` | Already reads `preferred_language` |

**Env (`.env.example`):**

```bash
PROPERA_TENANT_I18N_ENABLED=1
PROPERA_TENANT_TRANSLATE_MODEL=...   # reuse existing LLM config if present
```

When disabled: portal behaves as today (English only, no translate calls).

**Caching (recommended):** In-memory or short TTL cache keyed `hash(text):targetLocale` inside `translateTenantText.js` to avoid repeat LLM on every list poll. No DB table for MVP.

---

## propera-app modules

| Module | Responsibility |
|--------|----------------|
| `src/lib/tenant/i18n/` | `en.ts`, `es.ts`, `getTenantT(locale)` |
| `src/components/tenant/TenantLocaleProvider.tsx` | Wrap portal shell; `locale` from brand |
| `src/app/tenant/(portal)/profile/page.tsx` | Language picker → `PATCH profile` |
| All `src/app/tenant/**` pages | Replace hardcoded strings with `t(...)` |
| `src/lib/tenant/maintenanceTypes.ts` | `statusLabel(s, locale)`, category labels |
| `src/lib/tenant/accessTypes.ts` | `tenantAccessError(code, locale)` |

Use `preferredLanguage` for `Intl.DateTimeFormat` / `toLocaleDateString` locale argument.

**Do not** call translate APIs from the browser for DB text — **V2 returns display fields** so keys stay server-side and staff data never leaks translation logic to the client.

---

## Phased delivery

### Phase 1 — Preference + static UI (~2–3 days) ✅ shipped 2026-06-02

- [x] `PATCH` `preferredLanguage` (`en` \| `es`)
- [x] Profile language picker; `router.refresh()` after save
- [x] `TenantLocaleProvider` + `src/lib/tenant/i18n/` catalogs (shell, dashboard, profile, maintenance, amenities, notices, balance/lease)
- [x] Localized category + status + amenity error maps
- [x] Date formatting via `formatTenantDate` / `formatTenantDateTime`
- [x] `PROPERA_TENANT_I18N_ENABLED` env (translate layers Phase 2+; static UI uses profile without flag)
- [ ] Login page static strings (still English; browser locale optional follow-up)

### Phase 2 — English brain path (~1–2 days) ✅ shipped 2026-06-02

- [x] `detectTextLanguage` + `translateToEnglish` on maintenance **POST** (`tenantMaintenanceI18n.js`)
- [x] Tests: `tests/detectTextLanguage.test.js`, `tests/tenantMaintenanceI18n.test.js`
- [x] Structured logs: `TENANT_I18N_TRANSLATED`, `TENANT_I18N_WRITE_NORMALIZED`, `TENANT_I18N_TRANSLATE_FAILED`
- [x] Requires `PROPERA_TENANT_I18N_ENABLED=1` + `OPENAI_API_KEY`; optional `PROPERA_TENANT_TRANSLATE_MODEL`
- [x] `503 translation_unavailable` when LLM translate fails for Spanish content

### Phase 3 — Translate for display (~2–3 days) ✅ shipped 2026-06-02

- [x] `translateForDisplay` in `translateTenantText.js` (en↔es, cached)
- [x] `tenantDisplayI18n.js` — maintenance list/detail + timeline `actionDisplay`
- [x] Notices `titleDisplay` / `messageBodyDisplay`
- [x] App `pickDisplay()` on maintenance + notices pages
- [x] Detect-on-read: skip translate when content already `es`; assume English when `unknown`
- [x] Tests: `tests/tenantDisplayI18n.test.js`

### Phase 4 — Polish (~1 day) — partial ✅ 2026-06-02

- [ ] Login page static strings (browser locale optional)
- [ ] Amenity location `descriptionDisplay` on GET when UI `es`
- [x] Push prompt + subscribe error messages (`TenantPushPrompt`, `tenantPushErrors.ts`)
- [x] `docs/HANDOFF_LOG.md` dated section (2026-06-02)

**Total estimate:** ~6–8 dev days (one developer familiar with tenant routes).

---

## Testing

| Test | Repo |
|------|------|
| `PATCH profile` accepts `en`/`es`, rejects invalid | `propera-v2/tests/tenant/` |
| Spanish description → English in create payload (mock translator) | `propera-v2/tests/tenant/` |
| `translateForDisplay` skipped when locale matches | `propera-v2/tests/tenant/` |
| Category keys unchanged in POST body | `propera-app` or V2 |
| Staff portal regression | Manual — no code paths touched |

Run `cd propera-v2 && npm test` before merge.

---

## Guardrails checklist

- [ ] **Patch law:** Changes stay in `src/tenant/*` (V2) and `propera-app/src/app/tenant/*` + `src/lib/tenant/*` — not staff portal, not brain core.
- [ ] **No** hardcoded tenant/property strings outside messaging rules.
- [ ] **No** bypass of `runInboundPipeline` for ticket create.
- [ ] **No** Spanish (or mixed) text sent to brain when translate-on-write is enabled and detection says non-English.
- [ ] **Staff** continues to see English `message_raw` in existing PM UI.

---

## Agent handoff

When implementing tenant i18n:

1. Read this doc + [TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md).
2. Confirm locked decisions §1–4 unchanged.
3. Implement **Phase 1 → 2 → 3** in order; do not skip translate-on-write before advertising Spanish UI on maintenance create.
4. Update **Status** at top of this file and append **HANDOFF_LOG.md** when a phase ships.

---

*Last updated: 2026-06-02 — product decisions locked (display translate, English operational, en+es, profile+detect).*
