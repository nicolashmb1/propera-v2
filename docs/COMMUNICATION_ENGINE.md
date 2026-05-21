# Communication Engine — build plan (V1)

**Purpose:** Design north and phased build plan for **tenant broadcast SMS** on a **dedicated Twilio number**, separate from the maintenance brain. Shallow engine: capture, classify, log, redirect — **not** a second conversation brain.

**Audience:** product, engineering, next agent implementing comms.

**Related (do not duplicate):**

- [ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md) — main inbound order (`/webhooks/sms` → `runInboundPipeline`)
- [ADAPTER_ONBOARDING.md](./ADAPTER_ONBOARDING.md) — adapter-only boundary (comms is **not** a new brain lane)
- [PROPERA_GUARDRAILS.md](../propera-gas-reference/PROPERA_GUARDRAILS.md) — Patch Law; comms must not bypass resolver/lifecycle
- [TENANT_ROSTER_PORTAL.md](./TENANT_ROSTER_PORTAL.md) — `tenant_roster` is the resident phone source of truth today
- [TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md) — resident `/tenant/*` UI + notices read path
- [OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md) — Supabase + Twilio operator steps

**North compass alignment:** The **main brain** still owns maintenance lifecycle. The Communication Engine **never** runs `handleInboundCore` or `runInboundPipeline` for broadcast-number traffic. It may call a **single thin handoff** (`createMaintenanceTicketFromCommReply` — to be defined in `src/brain/` or `src/dal/`) when `reply_class` is `MAINTENANCE_SIGNAL` or `EMERGENCY_SIGNAL`.

---

## Architecture (two numbers, two front doors)

```text
Main Twilio number     → POST /webhooks/sms | /webhooks/twilio
                         → runInboundPipeline → maintenance / staff / leasing brain

Broadcast Twilio number → POST /webhooks/communications/sms
                         → Communication Engine (new, shallow)
                         → reply + delivery status only

                         POST /webhooks/communications/status
                         → deliveryTracker (Twilio callbacks)
```

| Property | Main brain | Communication Engine |
|----------|------------|----------------------|
| Conversational intake | Yes | **No** |
| Ticket lifecycle | Yes | Handoff seed only (explicit API) |
| Outbound `from` | `TWILIO_SMS_FROM` / WA | **`TWILIO_BROADCAST_FROM`** only |
| TCPA `sms_opt_out` (main) | Yes (SMS maintenance) | **Separate** `comm_broadcast_opt_out` on roster |
| Footer in broadcasts | N/A | **Always** via `appendFooter()` in `commOutgate` |

---

## Repo reality vs spec (read before coding)

| Spec term | V2 today | Build note |
|-----------|----------|------------|
| `tenants` table | **`tenant_roster`** (`012`) + **`units`** (`030`) | Audience resolver joins `tenant_roster` → `units` on `(property_code, unit_label)`; `tenant_roster.id` = `tenant_id` in comm tables |
| `unit_id` | **`units.id`** (uuid) | Floor filter uses **`units.floor`** (text — normalize/compare as string or parsed int) |
| `organizations` | **No table yet** | V1: `org_id text` on campaigns without FK, or migration **`055`** adds minimal `organizations` + brand columns |
| Property display names | **`properties.display_name`**, **`short_name`** (`003`/`008`) | Add **`display_name_short`**, **`comm_sender_label`** in **`055`**; seed Grand names in SQL |
| Main number env | **`TWILIO_SMS_FROM`** | Add **`TWILIO_BROADCAST_FROM`**, **`COMM_MAIN_NUMBER_DISPLAY`** (footer), **`COMM_REPLY_WINDOW_HOURS`** |
| `createTicketSeed()` | **Does not exist** | Phase D: implement **one** DAL/brain entry; do not duplicate finalize logic inside `src/communication/` |

**Properties in scope (seed / filters):** `PENN`, `MORRIS`, `MURRAY`, `WESTFIELD`, `WESTGRAND` (and `WGRA` if used in DB — always resolve from `properties`, never hardcode in engine code).

---

## Phase 1 build scope (V1)

| Layer | Deliverable |
|-------|-------------|
| Database | Migration **`055_communication_engine.sql`** (enums + 3 tables + brand/roster columns) |
| Backend | `src/communication/*` module |
| Webhooks | `src/webhooks/communicationsSms.js` mounted at `/webhooks/communications` |
| API | Portal-token routes under `/api/communications/*` (register in `registerPortalRoutes.js` or dedicated registrar) |
| Portal | `propera-app` **Communications** nav + list / composer / detail |

**Explicitly out of V1:** WhatsApp broadcast (schema allows `channel`; send path SMS-only first), scheduled cron worker (optional `scheduled_at` stored; send is manual or immediate POST), multi-org SaaS.

---

## 1. Database schema

**File:** `supabase/migrations/055_communication_engine.sql`

Run in Supabase SQL Editor after **`012`** (roster) and **`030`** (units). See migration file for full SQL.

### Enums

- `comm_type` — `BUILDING_UPDATE`, `MAINTENANCE_NOTICE`, `POLICY_REMINDER`, `EMERGENCY_ALERT`, `LEASE_ADMIN`
- `comm_status` — `DRAFT`, `QUEUED`, `SENDING`, `SENT`, `PARTIALLY_SENT`, `FAILED`, `CANCELLED`
- `comm_audience_kind` — `PORTFOLIO`, `PROPERTY`, `FLOOR`, `UNIT`, `TENANT`
- `recipient_status` — `PENDING`, `QUEUED`, `SENT`, `DELIVERED`, `FAILED`, `SKIPPED_NO_PHONE`, `SKIPPED_OPT_OUT`
- `reply_class` — `ACKNOWLEDGMENT`, `QUESTION`, `COMPLAINT`, `MAINTENANCE_SIGNAL`, `EMERGENCY_SIGNAL`, `OPT_OUT`, `UNKNOWN`

### Tables

| Table | Role |
|-------|------|
| **`communication_campaigns`** | Draft → send lifecycle, `audience_filter` jsonb, `audience_snapshot` at prepare, message body, totals |
| **`communication_recipients`** | One row per targeted tenant; **snapshots** locked at `prepareCampaign()` |
| **`communication_replies`** | Inbound on broadcast number; classification + optional ticket handoff |

### `audience_filter` jsonb shape

```json
{
  "property_codes": ["PENN", "MORRIS"],
  "floors": ["3"],
  "unit_ids": ["uuid"],
  "tenant_ids": ["uuid"]
}
```

Use **string floors** in JSON to match `units.floor` (text). UI may show numeric floors; persist normalized strings.

### `audience_snapshot` (at prepare / send)

```json
[
  {
    "tenantId": "uuid",
    "unitId": "uuid",
    "propertyCode": "PENN",
    "displayName": "The Grand at Penn",
    "unitLabel": "209",
    "name": "Jane Doe",
    "phone": "+1...",
    "channel": "sms"
  }
]
```

### Roster / brand columns (same migration)

| Target | Columns |
|--------|---------|
| **`organizations`** (new, minimal) | `id text PK`, `brand_name`, `brand_short_name` |
| **`properties`** | `display_name_short`, `comm_sender_label` ( `display_name` already exists ) |
| **`tenant_roster`** | `comm_broadcast_opt_out boolean default false`, `preferred_channel text default 'sms'` |

**Opt-out rule:** Broadcast STOP updates **`comm_broadcast_opt_out`** on `tenant_roster` — **not** the maintenance `sms_opt_out` table (`011`), so opting out of notices does not block maintenance SMS on the main number.

---

## 2. Backend file structure

```text
propera-v2/src/
  communication/
    index.js                    -- re-exports
    campaignService.js          -- CRUD, prepare, cancel
    audienceResolver.js         -- filter → RecipientCandidate[]
    brandContextService.js      -- DB brand + audience labels (no hardcoded Grand)
    messageComposer.js          -- AI draft + appendFooter (footer only in commOutgate for sends)
    commOutgate.js              -- Twilio send FROM broadcast number
    replyClassifier.js          -- deterministic + optional LLM
    replyHandler.js             -- inbound broadcast SMS
    deliveryTracker.js          -- status callback
  webhooks/
    communicationsSms.js        -- POST /sms, POST /status
```

**Mount in `src/index.js`:**

```js
const { registerCommunicationsWebhooks } = require("./webhooks/communicationsSms");
registerCommunicationsWebhooks(app);
```

**Portal API:** Add routes to `src/portal/registerPortalRoutes.js` (same portal token gate as other `/api/portal/*`) **or** `src/communication/registerCommunicationRoutes.js` called from index — prefer **one registrar** called from `registerPortalRoutes` to keep auth consistent.

**propera-app:** Proxy routes under `src/app/api/communications/**` → V2 `/api/communications/**` (mirror finance/PM proxy pattern).

---

## 3. Module specs

### `audienceResolver.js`

```js
/**
 * resolveAudience(filter, orgId) → RecipientCandidate[]
 * {
 *   tenantId,      // tenant_roster.id
 *   unitId,        // units.id
 *   propertyCode,
 *   unitLabelSnapshot,
 *   tenantNameSnapshot,
 *   phoneE164Snapshot,
 *   channel,       // 'sms' | 'whatsapp' (V1 send: sms only)
 *   skipReason?    // 'NO_PHONE' | 'OPT_OUT' | 'INACTIVE'
 * }
 *
 * Logic:
 * 1. FROM tenant_roster tr
 *    JOIN units u ON u.property_code = tr.property_code AND u.unit_label = tr.unit_label
 *    WHERE tr.active = true
 * 2. Filter property_codes, floors (u.floor), unit_ids, tenant_ids
 * 3. Normalize phone E.164 (reuse src/utils/phone.js)
 * 4. Skip comm_broadcast_opt_out → SKIPPED_OPT_OUT
 * 5. Skip empty phone → SKIPPED_NO_PHONE
 * 6. channel from tr.preferred_channel (default sms)
 */

/** getAudiencePreview(filter, orgId) → { audienceLabel, total, willSend, skippedNoPhone, skippedOptOut, byProperty[] } */
```

Preview **`audienceLabel`** uses **`getAudienceLabel()`** from `brandContextService` — tenant-facing names, not `PENN`.

### `brandContextService.js`

```js
/** getBrandContext(orgId, propertyCodes[]) → { orgBrandName, orgBrandShort, properties: { [code]: { displayName, displayNameShort, senderLabel } } } */
/** getAudienceLabel(brandContext, audienceKind, audienceFilter) → natural language string for composer + UI */
```

**Rules:**

- Never hardcode "The Grand" in engine code — load from **`organizations`** + **`properties`**
- **`senderLabel`:** `properties.comm_sender_label` ?? ``Management at ${display_name}``
- Word **"Propera"** must **never** appear in tenant-facing text

### `messageComposer.js`

```js
/**
 * draftMessage({ brief, commType, tone, language, brandContext, audienceLabel })
 * - Uses OPENAI_API_KEY (existing env) — model from env or gpt-4o-mini for cost
 * - System prompt includes brandContext.orgBrandName + audienceLabel
 * - Does NOT include footer (composer returns body only)
 */

/**
 * appendFooter(messageBody, brandContext, propertyCode, mainNumberDisplay, language, { isMultiProperty })
 * - Called from commOutgate ONLY before send
 * - EN/ES/PT footers per spec; maintenance redirect uses COMM_MAIN_NUMBER_DISPLAY
 */
```

### `commOutgate.js`

```js
/**
 * sendCampaign(campaignId)
 * 1. Load campaign + recipients status IN ('PENDING','QUEUED')
 * 2. brandContext = getBrandContext(...)
 * 3. For each recipient (100ms delay between sends):
 *    - fullBody = appendFooter(campaign.message_body, brandContext, recipient.property_code, ...)
 *    - twilioSend FROM env TWILIO_BROADCAST_FROM (new helper or param on twilioSendMessage)
 *    - Update recipient row + twilio_message_sid
 * 4. Roll up campaign totals + status SENT | PARTIALLY_SENT | FAILED
 */

/** sendSingle(recipientId) — retry one row */
```

Reuse **`src/outbound/twilioSendMessage.js`** with explicit **`from`** override — do not copy Twilio client setup.

### `replyClassifier.js`

Tier 1 regex (OPT_OUT, ACK, EMERGENCY, MAINTENANCE) → Tier 2 LLM only if UNKNOWN and len > 15 → else UNKNOWN.

### `replyHandler.js`

```js
/**
 * handleBroadcastReply({ From, Body, MessageSid })
 * 1. Normalize phone; lookup tenant_roster by phone_e164 (latest active)
 * 2. Match recent communication_recipients (sent_at within COMM_REPLY_WINDOW_HOURS)
 * 3. classifyReply(Body) → insert communication_replies
 * 4. OPT_OUT → set comm_broadcast_opt_out on roster
 * 5. Auto-response (all classes): redirect to main number — never maintenance intake here
 * 6. MAINTENANCE_SIGNAL | EMERGENCY_SIGNAL → createMaintenanceTicketFromCommReply(...) ; handoff_created=true
 * 7. Reply via broadcast FROM number
 * 8. Return empty TwiML (responses sent via API, not TwiML body)
 */
```

### `campaignService.js`

- `createCampaign`, `getCampaign`, `listCampaigns`, `updateCampaignStatus`
- `prepareCampaign` — resolve audience → insert recipients → `audience_snapshot` + `QUEUED`
- `cancelCampaign` — only `DRAFT` | `QUEUED`

### `deliveryTracker.js`

Map Twilio `MessageStatus` → `communication_recipients` by **`twilio_message_sid`**; update campaign aggregate counts.

---

## 4. Webhook routes

| Method | Path | Handler |
|--------|------|---------|
| POST | `/webhooks/communications/sms` | `handleBroadcastReply` |
| POST | `/webhooks/communications/status` | `handleDeliveryCallback` |

Configure **broadcast** Twilio number:

- Incoming → `https://<host>/webhooks/communications/sms`
- Status callback → `https://<host>/webhooks/communications/status`

**Do not** point the broadcast number at `/webhooks/sms`.

---

## 5. Portal API routes (V2)

All gated with **`verifyPortalRequest`** (same as other portal APIs). Suggested paths:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/communications/campaigns` | Create draft |
| GET | `/api/communications/campaigns` | List (`?status=&limit=&offset=`) |
| GET | `/api/communications/campaigns/:id` | Detail + recipient summary |
| POST | `/api/communications/draft` | AI draft body |
| POST | `/api/communications/campaigns/:id/resolve` | Audience preview (no send) |
| POST | `/api/communications/campaigns/:id/send` | `prepareCampaign` + `sendCampaign` (or prepare if still DRAFT) |
| GET | `/api/communications/campaigns/:id/recipients` | Delivery table |
| GET | `/api/communications/campaigns/:id/replies` | Reply log |
| POST | `/api/communications/campaigns/:id/cancel` | Cancel draft/queued |

**Feature flag (recommended):** `PROPERA_COMMUNICATION_ENGINE_ENABLED=1` + `NEXT_PUBLIC_PROPERA_COMMUNICATIONS_ENABLED=1` in propera-app.

---

## 6. Environment variables

Add to **`propera-v2/.env.example`** and operator `.env`:

```bash
# Communication Engine (broadcast number — separate from maintenance)
PROPERA_COMMUNICATION_ENGINE_ENABLED=0
TWILIO_BROADCAST_FROM=+1XXXXXXXXXX
COMM_MAIN_NUMBER_DISPLAY=+1XXXXXXXXXX
COMM_REPLY_WINDOW_HOURS=72
COMM_ORG_ID=grand
OPENAI_COMM_DRAFT_MODEL=gpt-4o-mini
```

Existing **`TWILIO_ACCOUNT_SID`**, **`TWILIO_AUTH_TOKEN`**, **`TWILIO_SMS_FROM`** unchanged for main brain.

---

## 7. Portal UI (`propera-app`)

| Route | Screen |
|-------|--------|
| `/communications` | Campaign list (Drafts / Scheduled / Sent) |
| `/communications/new` | 4-step composer (type → audience → compose → preview) |
| `/communications/[id]` | Detail: delivery stats, recipients, replies |

**Step highlights:**

- Audience preview shows **`audienceLabel`** + display names (not raw `PENN` only)
- Message preview = body + **footer preview** (call `appendFooter` client-side via API preview endpoint or include in resolve response)
- SMS segment estimate on compose step

---

## 8. Build order (ship phases independently)

### Phase A — Foundation

1. Run **`055_communication_engine.sql`**
2. Seed `organizations` + property display columns (Grand copy in migration comments)
3. Provision **second Twilio number**; set env vars
4. Mount webhooks with **stub** handler (`<Response/>` only)
5. Verify Twilio hits `/webhooks/communications/sms`

### Phase B — Audience

1. `brandContextService.js` + `audienceResolver.js`
2. `campaignService.js` (create + prepare)
3. API: create campaign + resolve preview
4. Test: PENN floor 3 → recipient list with skips

### Phase C — Compose + send

1. `messageComposer.js` + `commOutgate.js`
2. API: draft + send
3. Test: send to your own phone from **broadcast** FROM; footer present

### Phase D — Replies + delivery

1. `replyClassifier.js` + `replyHandler.js`
2. `deliveryTracker.js` + status route
3. Implement **`createMaintenanceTicketFromCommReply`** in brain/DAL (thin)
4. Test: reply STOP, reply "ok", reply "leak in kitchen"

### Phase E — Portal UI

1. List + new wizard steps 1–2
2. Compose + AI draft + preview
3. Detail + recipients + replies tabs

---

## 9. Guardrails (non-optional)

| Rule | Why |
|------|-----|
| **`appendFooter()` only in `commOutgate.js`** | No draft/API path sends without footer |
| **Broadcast webhooks never call `runInboundPipeline`** | Prevents maintenance brain eating notices |
| **Snapshots on `prepareCampaign`** | Historical sends stay accurate if roster changes |
| **`TWILIO_BROADCAST_FROM` for all comm sends** | Never use main maintenance FROM |
| **Status updates match on `twilio_message_sid`** | Not campaign_id alone |
| **`getBrandContext()` before compose/send** | No hardcoded client/property names |
| **No "Propera" in tenant copy** | Product is invisible to residents |
| **Patch Law** | New code lives in `src/communication/` + webhook registrar; brain handoff is one function call |

---

## 10. Testing strategy

| Test | Location |
|------|----------|
| `replyClassifier` regex tiers | `tests/communicationReplyClassifier.test.js` |
| `getAudienceLabel` / filter expansion | `tests/communicationAudienceResolver.test.js` |
| `appendFooter` EN/ES/PT | `tests/communicationMessageComposer.test.js` |
| Webhook smoke (stub) | Manual + optional supertest on `/webhooks/communications/sms` |

Full send/receive tests require Twilio credentials — mark integration in [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) when added.

---

## 11. Documentation discipline

When a phase ships, update:

| Doc | When |
|-----|------|
| **This file** | Phase status table below |
| **[AGENTS.md](../AGENTS.md)** | Row in "Where everything lives" |
| **[OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md)** | Twilio + migration 055 steps |
| **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** | Dated session note |
| **`supabase/migrations/README.md`** | Row for 055 |

### Phase status

| Phase | Status |
|-------|--------|
| A — Foundation | Not started |
| B — Audience | Not started |
| C — Compose + send | Not started |
| D — Replies + delivery | Not started |
| E — Portal UI | Not started |

---

## Changelog

| Date | Note |
|------|------|
| 2026-05-20 | Initial build plan: architecture, schema 055, module specs, API, UI, brand layer, repo mapping (`tenant_roster`/`units`), guardrails. |
