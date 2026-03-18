# Propera — Outgate & Expression Layer Map

**Purpose:** Map the path from *brain decision* to *user-facing message* so the system can evolve from **decision → direct text** to **decision → canonical outbound intent → rendered message**. No build yet; this is the wiring map.

---

## 1. The Picture (North Star)

- **Brain** already does the hard work: domain, facts, next state, next action.
- **Weak today:** the *expression layer* — how it says it, how clean/natural it feels, how much internal structure leaks.
- **Target:** Brain outputs **structured meaning**; **Outgate** renders **expression** (and is the right place for AI: phrasing, tone, translation, channel adaptation).

**Target flow:**
```
decision → canonical outbound intent → Outgate render → channel delivery
```

**Canonical outbound intent (goal shape):**
- `intent` (e.g. `ASK_SCHEDULE_WINDOW`, `TICKET_CREATED`, `CONFIRM_AMENITY`)
- `audience` (TENANT | STAFF)
- `facts` (propertyName, unit, issueLabel, ticketId, …)
- `language`, `channel`, `style`, `constraints`
- Outgate turns that into the final message (template today; AI later).

---

## 2. High-Level Flow (Current)

```
Inbound (SMS/WhatsApp/Alexa/…)
  → handleSmsSafe_(e) → handleSmsCore_(e)
  → compileTurn_()           → turnFacts (property, unit, issue, schedule)
  → draftUpsertFromTurn_()   → Directory draft updated
  → resolveEffectiveTicketState_(dir, dirRow, ctx, session)  → { stateType, stage }
  → Stage branch (PROPERTY | UNIT | ISSUE | CONFIRM_CONTEXT | SCHEDULE | DETAIL | …)
  → finalizeDraftAndCreateTicket_() when READY, or stage-specific handler
  → reply_(renderTenantKey_(templateKey, lang, baseVars))   ← direct text today
  → sendRouterSms_() / sendSms_() / sendWhatsApp_()
```

**Lifecycle (post-ticket):**
```
Lifecycle policy evaluate → decision { action, nextState, … }
  → wiEnterState_() → optional dispatchOutboundIntent_() for STAFF_UPDATE_REMINDER, TENANT_VERIFY_RESOLUTION
```

---

## 3. Brain / Decision Functions (What to Do)

### 3.1 `compileTurn_(bodyTrim, phone, lang, baseVars)`  
**File:** `PROPERA MAIN.gs` (≈2470)

- **Role:** Context compiler. Turns raw body into structured turn facts.
- **Returns:** `{ property: {code,name}|null, unit: string, issue: string, schedule: {raw}|null, … }`.
- **Used by:** All stage logic; draft accumulator; no direct outbound — feeds *what we know*.

```javascript
function compileTurn_(bodyTrim, phone, lang, baseVars) {
  // Schedule: isScheduleLike_ → schedule = { raw: t }
  // Property: resolvePropertyExplicitOnly_ / resolvePropertyFromText_ → property = { code, name }
  // Unit: extractUnit_ → normalizeUnit_
  // Issue: from body; issueMeta from deterministic parser
  return { property, unit, issue, schedule, issueMeta, ... };
}
```

---

### 3.2 `draftUpsertFromTurn_(dir, dirRow, turnFacts, bodyTrim, phone, sessionOpt)`  
**File:** `PROPERA MAIN.gs` (≈1663)

- **Role:** Writes draft state to Directory (pending property, unit, issue, issue buffer). No outbound.

---

### 3.3 `resolveEffectiveTicketState_(dir, dirRow, ctx, session)`  
**File:** `PROPERA MAIN.gs` (≈2213)

- **Role:** Decides whether we’re in DRAFT, CONTINUATION, or NEW and which *stage* we’re in.
- **Returns:** `{ stateType: "NEW"|"DRAFT"|"CONTINUATION", stage: string }`.
- **Stages:** e.g. `PROPERTY`, `UNIT`, `ISSUE`, `CONFIRM_CONTEXT`, `SCHEDULE`, `DETAIL`, `SCHEDULE_DRAFT_MULTI`, `EMERGENCY_DONE`.

```javascript
// Continuation: UNIT, SCHEDULE, DETAIL (with PendingRow)
// Draft: PROPERTY, UNIT, ISSUE, CONFIRM_CONTEXT, FINALIZE_DRAFT, INTENT_PICK, SCHEDULE_DRAFT_MULTI
// Emergency: EMERGENCY_DONE
```

- **Used by:** `handleSmsCore_` to set `effectiveStage` and branch to the right handler. Drives *which* message intent is needed (ask unit, ask schedule, confirm, etc.).

---

### 3.4 `draftDecideNextStage_(dir, dirRow)`  
**File:** `PROPERA MAIN.gs` (≈2291)

- **Role:** For draft flow only. Returns next missing field or `"READY"`.
- **Returns:** `"PROPERTY" | "ISSUE" | "READY"`.
- **Used by:** After CONFIRM_YES and similar; when `READY` → `finalizeDraftAndCreateTicket_()`.

```javascript
function draftDecideNextStage_(dir, dirRow) {
  if (!propCode) return "PROPERTY";
  if (!hasIssue) return "ISSUE";
  return "READY";
}
```

---

### 3.5 `finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, from, opts)`  
**File:** `PROPERA MAIN.gs` (≈2665)

- **Role:** Creates ticket row, updates Directory (PendingRow, PendingStage), decides next stage (SCHEDULE, UNIT, "", EMERGENCY_DONE, common area).
- **Returns:** `{ ok, loggedRow, ticketId, createdWi, nextStage, summaryMsg?, multiIssuePending?, ackOwnedByPolicy?, … }`.
- **Critical for expression:** Callers use `result.nextStage` and `result.summaryMsg` to choose **what to say** (ticket created + ask schedule, common area ack, multi-issue summary, etc.). Today they call `reply_(renderTenantKey_(...))` directly with keys like `ASK_WINDOW_SIMPLE`, `TICKET_CREATED_COMMON_AREA`, `ASK_UNIT`.

**Representative call site (post–finalize reply):**
```javascript
// PROPERA MAIN.gs ~15302–15322
var combined = result.summaryMsg || renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
replyNoHeader_(combined);
// or
replyNoHeader_(renderTenantKey_("TICKET_CREATED_COMMON_AREA", lang, { ...baseVars, ticketId }));
reply_(renderTenantKey_("ASK_UNIT", lang, baseVars));
replyNoHeader_(renderTenantKey_("ASK_WINDOW_SIMPLE", lang, { ...baseVars, dayLine }));
```

**Target:** These should become a single outbound intent (e.g. `TICKET_CREATED_ASK_SCHEDULE`) with facts; Outgate renders.

---

### 3.6 Lifecycle decision → Outgate (already canonical)  
**File:** `LIFECYCLE_ENGINE.gs` (≈283–550)

- **Role:** Policy evaluates WI state → `decision { decision, action, nextState, tenantVerify, timerType, … }`.
- **Actions:** e.g. `TRANSITION`, `TRANSITION_AND_TIMER`, `PING_AND_RESTART`, `SEND_TENANT_VERIFY`, `WRITE_TIMER`.
- **Outbound:** Already uses `dispatchOutboundIntent_()` with structured intent:
  - `TENANT_VERIFY_RESOLUTION` (tenant)
  - `REQUEST_STAFF_UPDATE` + `STAFF_UPDATE_REMINDER` (staff)

```javascript
// wiEnterState_ → opts.sendTenantVerify → dispatchOutboundIntent_({
//   intentType: "TENANT_VERIFY_RESOLUTION", templateKey: "TENANT_VERIFY_RESOLUTION",
//   recipientType: "TENANT", recipientRef: opts.phone, vars: {}, ...
// });
// decision.action === "PING_AND_RESTART" → dispatchOutboundIntent_({
//   intentType: "REQUEST_STAFF_UPDATE", templateKey: "STAFF_UPDATE_REMINDER",
//   recipientType: "STAFF", recipientRef: wi.ownerId, ...
// });
```

---

## 4. Expression Layer (Current: Template → Text)

### 4.1 `renderTenantKey_(key, lang, vars)`  
**File:** `PROPERA MAIN.gs` (≈9568)

- **Role:** The only allowed place to render a template key for tenant-facing text (per M8). Adds welcome line (allowlisted keys), compliance footer (allowlisted), sanitization.
- **Calls:** `tenantMsgSafe_(key, L, V, "ERR_GENERIC_TRY_AGAIN")` then `sanitizeTenantText_`, optional welcome/footer.

```javascript
function renderTenantKey_(key, lang, vars) {
  let body = tenantMsgSafe_(key, L, V, "ERR_GENERIC_TRY_AGAIN");
  body = sanitizeTenantText_(body);
  if (shouldPrependWelcome_(key)) { /* welcomeLine */ }
  if (shouldAppendCompliance_(key)) { /* COMPLIANCE_FOOTER */ }
  return sanitizeTenantText_(body);
}
```

---

### 4.2 `tenantMsgSafe_(key, lang, vars, fallbackKey)`  
**File:** `PROPERA MAIN.gs` (≈9484)

- **Role:** Safe template lookup; fallback key if primary missing; logs TEMPLATE_EMPTY.
- **Calls:** `tenantMsg_(k, L, vars)`.

---

### 4.3 `tenantMsg_(key, lang, vars)`  
**File:** `PROPERA MAIN.gs` (≈13337)

- **Role:** Low-level template body lookup by key (and name); injects `brandName`, `teamName`; replaces `{placeholder}` via `renderTemplatePlaceholders_`.
- **Backing store:** `getTemplateMapCached_()` → sheet **Templates** (columns: TemplateID, **TemplateKey**, TemplateName, **TemplateBody**).
- **Returns:** Rendered string or "" if missing (with minimal hardcoded fallbacks for a few keys).

```javascript
const map = getTemplateMapCached_();
// byKey[key] or byName[key] → body
body = sanitizeTemplateBody_(body);
return renderTemplatePlaceholders_(body, data);
```

---

### 4.4 `getTemplateMapCached_()`  
**File:** `PROPERA MAIN.gs` (≈13374)

- **Role:** Loads Templates sheet (LOG_SHEET_ID), builds `{ byKey: { [TemplateKey]: body }, byName: { [TemplateName]: body } }`, caches 5 min.

---

### 4.5 Delivery: `reply_` / `replyNoHeader_`  
**File:** `PROPERA MAIN.gs` (≈14766, ≈14805)

- **Role:** Request-scoped. Appends to outbound; uses `globalThis.__inboundChannel` to choose SMS vs WA.
- **reply_(text):** Sends `text` to `phone` (from closure) via `sendSms_` or `sendWhatsApp_`.
- **replyNoHeader_(text):** Same, no welcome header.

---

### 4.6 `sendRouterSms_(to, text, tag)`  
**File:** `PROPERA MAIN.gs` (≈18870)

- **Role:** Central router for outbound SMS/WA: opt-out bypass, then `globalThis.__inboundChannel` → `sendWhatsApp_` or `sendSms_`. Used by Outgate `ogDeliver_` and many direct callers.

```javascript
var ch = String(globalThis.__inboundChannel || "SMS").toUpperCase();
if (ch === "WA") sendWhatsApp_(...); else sendSms_(...);
```

---

### 4.7 `sendSms_(sid, token, fromNumber, toNumber, message, tagOpt, tidOpt)`  
**File:** `PROPERA MAIN.gs` (≈9738)

- **Role:** Twilio SMS send; logging; DEV_MODE outbox.

---

## 5. Outgate (Canonical Outbound Path)

### 5.1 `dispatchOutboundIntent_(intent)`  
**File:** `OUTGATE.gs` (≈17)

- **Role:** Single entry for outbound intents (migrated paths). Validates intent, resolves recipient, language, renders message, delivers.
- **Intent shape (V1):** `{ intentType, templateKey, recipientType, recipientRef, vars?, deliveryPolicy?, meta? }`.
- **recipientType:** `TENANT` (recipientRef = phone) or `STAFF` (recipientRef = staffId).

```javascript
// Validate intentType, templateKey, recipientType, recipientRef
// recipient = ogResolveRecipient_(intent)
// lang = ogResolveLang_(intent, recipient)
// message = ogRenderIntent_(intent, lang)   ← renderTenantKey_(templateKey, lang, vars)
// ogDeliver_(intent, recipient, message)   ← sendRouterSms_(phone, message, intentType)
```

---

### 5.2 `ogResolveRecipient_(intent)`  
**File:** `OUTGATE.gs` (≈74)

- **Role:** TENANT → phoneKey_(ref), ctxGet_(ref) for lang; STAFF → srLoadStaffContact_(ref) for phoneE164 and lang.
- **Returns:** `{ ok, phoneE164, lang? }`.

---

### 5.3 `ogResolveLang_(intent, recipient)`  
**File:** `OUTGATE.gs` (≈108)

- **Role:** `recipient.lang` or `"en"`.

---

### 5.4 `ogRenderIntent_(intent, lang)`  
**File:** `OUTGATE.gs` (≈124)

- **Role:** V1: `renderTenantKey_(templateKey, lang || "en", intent.vars)`. This is where you can later swap to an AI renderer that takes intent + facts + channel.

---

### 5.5 `ogDeliver_(intent, recipient, message)`  
**File:** `OUTGATE.gs` (≈150)

- **Role:** Calls `sendRouterSms_(recipient.phoneE164, message, intent.intentType)` (tag for logging).

---

### 5.6 `outgateBuildAlexaReply_(ctx)`  
**File:** `OUTGATE.gs` (≈171)

- **Role:** Builds Alexa reply *content* from pipeline/context (device not linked, error, launch, ticket created, no maintenance, generic). Uses same template keys (ALEXA_*) and `renderTenantKey_`. No delivery; adapter wraps in Alexa JSON.

---

## 6. Template Keys (Facts for the Map)

These are the main keys used as “what to say” today. They are the natural candidates for **intent types** or **templateKey** in a canonical intent.

**Ticket / schedule flow:**  
`ASK_WINDOW_SIMPLE`, `ASK_WINDOW`, `ASK_WINDOW_WITH_DAYHINT`, `ASK_WINDOW_DAYLINE_HINT`, `CONFIRM_WINDOW_FROM_NOTE`, `TICKET_CREATED_COMMON_AREA`, `MULTI_CAPTURED_SUMMARY`, `MULTI_ISSUE_SUMMARY`, `MULTI_CREATED_CONFIRM`, `ASK_UNIT`, `ASK_UNIT_GOT_PROPERTY`, `ASK_ISSUE_GENERIC`, `ASK_DETAIL`, `ERR_DRAFT_FINALIZE_FAILED`, `CONFIRM_CONTEXT_NEEDS_CONFIRM`, `CONFIRM_CONTEXT_YESNO_REPROMPT`, `CONFIRM_CONTEXT_MISMATCH`, `CONFIRM_WINDOW_SET`.

**Property / menu:**  
`ASK_PROPERTY_MENU`, `ASK_PROPERTY_GOT_UNIT`, `ASK_PROPERTY_GOT_ISSUE`, `INTENT_PICK`, `WELCOME`.

**Emergency:**  
`EMERGENCY_CONFIRMED_DISPATCHED`, `EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID`, `EMERGENCY_ACK_RECEIVED`, `EMERGENCY_UPDATE_ACK`.

**Lifecycle (already via Outgate):**  
`TENANT_VERIFY_RESOLUTION`, `STAFF_UPDATE_REMINDER`.

**Router / compliance:**  
`TENANT_RESET_OK`, `TENANT_OPTIONS_MENU`, `SMS_HELP`, `SMS_STOP_CONFIRM`, `SMS_START_CONFIRM`, `TENANT_ACK_NO_PENDING`, `ERR_GENERIC_TRY_AGAIN`, `ERR_CRASH_FALLBACK`, `COMPLIANCE_FOOTER`.

**Alexa (Outgate):**  
`ALEXA_DEVICE_NOT_LINKED`, `ALEXA_ERROR`, `ALEXA_LAUNCH`, `ALEXA_TICKET_CREATED`, `ALEXA_NO_MAINTENANCE`, `ALEXA_PROCESSED`.

**Other:**  
`MGR_CREATED_TICKET_INTRO`, `QUEUE_NEXT_TICKET_SCHEDULE_PROMPT`, `CLEANING_WORKITEM_ACK`, `VENDOR_DISPATCH_REQUEST`, tenant self-service (TENANT_MY_TICKETS_*, TENANT_STATUS_*, TENANT_CANCEL_*, TENANT_CHANGE_TIME_*, CANCEL_*).

---

## 7. Where to Wire: Call Sites to Migrate

**Pattern today:** `reply_(renderTenantKey_(templateKey, lang, baseVars))` or `replyNoHeader_(...)`.

**Target pattern:** Build a canonical intent (intentType + templateKey or higher-level intent, audience, facts, lang, channel), then either:
- Call `dispatchOutboundIntent_({ intentType, templateKey, recipientType: "TENANT", recipientRef: phone, vars: baseVars, ... })`, or
- Add a new layer: brain pushes **canonical outbound intent** (e.g. `ASK_SCHEDULE_WINDOW` with facts); Outgate maps intent → templateKey / AI and calls existing `ogRenderIntent_` + `ogDeliver_`.

**High-value call sites (examples):**
- After `finalizeDraftAndCreateTicket_`: ticket created + ask schedule, common area ack, ask unit, multi summary (PROPERA MAIN.gs ≈15302–15322, ≈15309–15311, ≈15778–15785, ≈15856–15867).
- Stage handlers that send “ask” messages: ASK_UNIT, ASK_ISSUE_GENERIC, ASK_PROPERTY_MENU, ASK_WINDOW_*, CONFIRM_* (scattered in handleSmsCore_ stage branches).
- Emergency acks (≈10636–10638, ≈15954–15955, ≈16253–16254).
- Router / commands: CMD_START_OVER, CMD_OPTIONS, CMD_HELP, INTENT_PICK (≈5249–5256, ≈5798–5810).
- Error fallbacks: ERR_DRAFT_FINALIZE_FAILED, ERR_GENERIC_TRY_AGAIN (≈15292, ≈13470, etc.).

---

## 8. Summary Table

| Layer           | Key function(s)                     | File          | Role |
|----------------|--------------------------------------|---------------|------|
| Brain / state  | `compileTurn_`                       | PROPERA MAIN  | Turn → facts |
| Brain / state  | `resolveEffectiveTicketState_`       | PROPERA MAIN  | Stage for routing |
| Brain / state  | `draftDecideNextStage_`              | PROPERA MAIN  | Next missing or READY |
| Brain / commit | `finalizeDraftAndCreateTicket_`       | PROPERA MAIN  | Create ticket + nextStage |
| Brain / lifecycle | Lifecycle evaluate + `wiEnterState_` | LIFECYCLE_ENGINE | Decision → state + optional Outgate |
| Expression     | `renderTenantKey_`                   | PROPERA MAIN  | Key + lang + vars → text (with welcome/footer) |
| Expression     | `tenantMsg_`                         | PROPERA MAIN  | Template lookup + placeholders |
| Expression     | `reply_` / `replyNoHeader_`           | PROPERA MAIN  | Send to current request phone (SMS/WA) |
| Outgate        | `dispatchOutboundIntent_`            | OUTGATE.gs    | Intent → recipient, lang, render, deliver |
| Outgate        | `ogRenderIntent_`                    | OUTGATE.gs    | templateKey + vars → message (V1: renderTenantKey_) |
| Outgate        | `ogDeliver_`                         | OUTGATE.gs    | sendRouterSms_ |
| Delivery       | `sendRouterSms_`                      | PROPERA MAIN  | Channel (SMS/WA) + send |
| Delivery       | `sendSms_` / `sendWhatsApp_`          | PROPERA MAIN  | Twilio send |
| Data           | Templates sheet                      | (LOG_SHEET_ID)| TemplateKey, TemplateBody |

---

**Next evolution:**  
- Brain emits **canonical outbound intent** (intent type + facts + audience + channel + language) instead of ad‑hoc `reply_(renderTenantKey_(...))`.  
- Outgate owns **how it’s said**: template selection, placeholder fill, and later AI phrasing/tone/translation/channel adaptation.  
- Message becomes a first-class artifact: communication goal + approved facts + audience + channel + language + constraints → Outgate renders.
