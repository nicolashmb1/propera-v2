# Propera Outgate Expression Map — Phased Execution Plan

**Reference:** [PROPERA_OUTGATE_EXPRESSION_MAP.md](PROPERA_OUTGATE_EXPRESSION_MAP.md) — canonical flow, intent shape (`intent`, `audience`, `facts`, `language`, **`channel`**, `style`, `constraints`), and expression-layer ownership. Map §1: Outgate renders expression and is the right place for channel adaptation; same intent must yield different messages per channel (SMS + footer, WA no footer/richer, voice separate).

**Goal:** Migrate from *decision → direct `reply_(renderTenantKey_(...))`* to *decision → canonical outbound intent → Outgate render (per channel) → delivery*. Outgate owns **how** it's said; SMS, WhatsApp, and voice must **not** be the same message.

**Constraints (from expression map + guardrails):**
- Brain outputs **structured meaning** (intent + facts + audience); Outgate owns **expression** (phrasing, tone, translation, **channel adaptation**).
- One canonical outbound path: extend existing `dispatchOutboundIntent_`; no second messaging stack.
- No bypass of resolver or lifecycle; patch scope M8 (Messaging/Outgate) and call sites in PROPERA MAIN.gs only.

---

## Channel-aware rendering (required)

Per the expression map, intent includes `language`, **`channel`**, `style`, `constraints`. Outgate must render **per channel** — not one message for all.

| Channel | Rules | Notes |
|--------|--------|-------|
| **SMS** | Compliance footer **required** where applicable (allowlisted keys). Welcome line per key. Character limits, plain text. | Current `renderTenantKey_` + `shouldAppendCompliance_` behavior. |
| **WhatsApp** | **No compliance footer.** Can be **richer** (formatting, structure, optional media). Same intent, different rendering. | Outgate must not append SMS footer when channel is WA. |
| **Voice (Alexa)** | **Different message** — short, speakable, no footer. Already uses `ALEXA_*` templates and `outgateBuildAlexaReply_`; not the same as SMS/WA. | Keep voice path separate; do not reuse SMS body as TTS. |

**Implication for the plan:** Before or during migration, Outgate's render path must take **channel** from the request (e.g. `__inboundChannel` or explicit `intent.channel`) and:
- **SMS:** apply compliance footer (and welcome) per existing allowlists.
- **WA:** render without compliance footer; optionally use WA-specific template variants or richer format later.
- **Voice:** handled by Alexa adapter + `outgateBuildAlexaReply_`; no change to SMS/WA body.

---

## Render/delivery channel alignment (critical invariant)

**Biggest hidden risk:** Render channel and delivery channel must stay aligned. The current system mixes render choice, `sendRouterSms_()` behavior, and request-scoped globals (`globalThis.__inboundChannel`). If Outgate renders as WA (no footer) but delivery still routes as SMS, you get a WA-style message over SMS — or the reverse.

**V1 rule — one source of truth for channel:**
- For migrated request-time paths: **pass channel** in the intent (from `__inboundChannel` at call site).
- Outgate **render** uses `intent.channel`.
- **Delivery** must use the same resolved channel. If `sendRouterSms_()` today only reads `globalThis.__inboundChannel`, then:
  - **Rollout note:** For same-turn inbound replies, `intent.channel` must match `globalThis.__inboundChannel`; otherwise render/delivery mismatch is possible. Call sites must pass the same value they would have used for routing.
  - **Preferred:** In Phase 0, have `ogDeliver_()` (or a small channel-aware router helper) prefer: `intent.channel` → request global → default SMS. Same stack, tighter control; no second messaging path.

**Invariant to verify before Phase 1:**  
For migrated same-turn paths: if `channel === "WA"`, delivery must actually go to WA; if `channel === "SMS"`, delivery must go to SMS. Otherwise: SMS without footer, WA with SMS footer, or wrong formatting on wrong transport.

---

## V1 intent contract

Use this shape for every migrated call so behavior and logging stay consistent. In V1, `intentType` may equal `templateKey` for parity migration; over time, `intentType` becomes the semantic meaning and `templateKey` becomes an Outgate rendering choice.

```javascript
{
  intentType: "ASK_UNIT",
  templateKey: "ASK_UNIT",
  recipientType: "TENANT",
  recipientRef: phone,
  lang: "en",
  channel: "SMS" | "WA",
  deliveryPolicy: "DIRECT_SEND" | "NO_HEADER",
  vars: { ... },
  meta: {
    source: "HANDLE_SMS_CORE",
    stage: "UNIT",
    flow: "MAINTENANCE_INTAKE"
  }
}
```

- **deliveryPolicy:** `"DIRECT_SEND"` = add welcome line when key is allowlisted (current `reply_` behavior). `"NO_HEADER"` = no welcome (current `replyNoHeader_` behavior). Required for parity: these are not equivalent inside the same channel.
- **channel:** Resolved from request (e.g. `__inboundChannel`) and used for both render and delivery.
- **meta:** Optional; helps logging and debugging.

---

## Principle: Replace in place, one path at a time

- **Pattern:** Replace `reply_(renderTenantKey_(...))` or `replyNoHeader_(renderTenantKey_(...))` with `dispatchOutboundIntent_()` using the V1 intent contract above (intentType, templateKey, recipientType, recipientRef, vars, **channel**, **deliveryPolicy**).
- **Behavior:** Outgate branches by **channel** (SMS footer vs WA no footer) and **deliveryPolicy** (welcome vs no header). Same intent, correct presentation per call site.
- **Scope per phase:** Migrate whole branches or whole template-key clusters so we never mix "reply then dispatch" in the same flow (avoids ordering/duplication).

---

## Phase 0: Render parity foundation

**Goal:** Channel-aware **and** presentation-aware render parity. No call-site migration yet (or minimal). After Phase 0, Outgate can safely replace both `reply_()` and `replyNoHeader_()` without changing live behavior.

1. **Intent supports channel**
   - Intent (V1) includes `channel`: `"SMS" | "WA"`. From handleSmsCore_, pass `channel: globalThis.__inboundChannel || "SMS"`. Used for both render and delivery (see Render/delivery channel alignment).
2. **Intent supports deliveryPolicy (presentation)**
   - Intent includes `deliveryPolicy`: `"DIRECT_SEND"` (welcome line when key allowlisted — current `reply_`) or `"NO_HEADER"` (no welcome — current `replyNoHeader_`). Without this, migrating `replyNoHeader_(renderTenantKey_(...))` would change behavior.
3. **Intent supports lang**
   - `intent.lang` override when present; else recipient.lang; else `"en"`.
4. **Outgate render branches by channel and deliveryPolicy**
   - **SMS:** template + (welcome if deliveryPolicy !== "NO_HEADER" and key allowlisted) + **compliance footer** per allowlist.
   - **WA:** same template body, **no compliance footer**; (welcome only if deliveryPolicy !== "NO_HEADER"). Richer formatting later.
   - **Voice:** unchanged (ALEXA_* / `outgateBuildAlexaReply_`).
5. **Delivery uses same channel as render**
   - Prefer `intent.channel` in delivery path (e.g. channel-aware router helper: intent.channel → request global → default SMS). Ensures WA-rendered message goes to WA, not SMS.
6. **Logging**
   - Log intentType, templateKey, channel, deliveryPolicy, recipientType, lang (for debugging and audit).
7. **Checklist for each migration**
   - [ ] Call site in PROPERA MAIN.gs (or allowed M8 caller).
   - [ ] One reply → one `dispatchOutboundIntent_` with same templateKey, vars, **channel**, and **deliveryPolicy** (DIRECT_SEND for former `reply_`, NO_HEADER for former `replyNoHeader_`).
   - [ ] recipientRef, recipientType; no change to compileTurn_, resolveEffectiveTicketState_, finalizeDraftAndCreateTicket_, lifecycle.

**Deliverable:** Outgate render path is **channel-aware + presentation-aware**; intent contract includes channel, deliveryPolicy, lang; delivery aligns with render channel; logging in place. Intent list + migration checklist.

---

## Phase 1: One high-traffic, single-reply path (pilot)

**Goal:** Prove the pattern on one path with minimal risk and no branching.

**Candidate:** A single "ask" that runs often and has one reply only, e.g. **ASK_UNIT** in one clear call site.

**Steps:**
1. Pick **one** call site (e.g. after CONFIRM_YES when `nextMissing === "UNIT"` → `reply_(renderTenantKey_("ASK_UNIT", lang, baseVars))` around 15339).
2. Replace with `dispatchOutboundIntent_()` using full V1 contract: intentType, templateKey, recipientType, recipientRef, vars, **channel** (from `__inboundChannel`), **deliveryPolicy: "DIRECT_SEND"** (because this was `reply_`, not `replyNoHeader_`).
3. **Fallback rule:** Use fallback (`else { reply_(renderTenantKey_(...)); }`) only as a short-lived migration harness or behind a dev flag. Deploy pilot with fallback once → verify → **remove fallback immediately when stable**. Do not leave half paths silently bypassing Outgate in production.
4. **Acceptance checks:**
   - **SMS:** Output is byte-for-byte equivalent to old path except for known sanitized differences.
   - **WA:** Same message body semantics, but **without** compliance footer.

**Why this first:** Single reply, no combined messages, no multi-branch logic. Easy to reason about and roll back.

**Guardrails:** No change to stage resolution or draft logic; only the expression delivery path changes.

---

## Phase 2: All ASK_UNIT and ASK_ISSUE_GENERIC (same-stage "ask" cluster)

**Goal:** Migrate all "we're asking for one thing" replies that use a single template key.

**Template keys:** `ASK_UNIT`, `ASK_UNIT_GOT_PROPERTY`, `ASK_ISSUE_GENERIC`.

**Steps:**
1. Grep for every `renderTenantKey_("ASK_UNIT"`, `"ASK_UNIT_GOT_PROPERTY"`, `"ASK_ISSUE_GENERIC"` used in a `reply_` or `replyNoHeader_`.
2. Replace each with `dispatchOutboundIntent_` (intentType = templateKey, same vars, recipientRef, **channel**, **deliveryPolicy**: DIRECT_SEND for `reply_`, NO_HEADER for `replyNoHeader_`).
3. Do not migrate branches that send a *combined* message (e.g. `combined = result.summaryMsg || renderTenantKey_(...)` then `replyNoHeader_(combined)`) — leave those for Phase 3b / Phase 7.

**Risk:** Low. Same pattern as Phase 1; just more call sites.

---

## Phase 3a: Post-finalize block — single-template replies only ✅ Done

**Goal:** All **single-template** replies in the block immediately after `finalizeDraftAndCreateTicket_()` go through Outgate.

**Call sites (from map):** ~15302–15324, ~15778–15787, ~15856–15867, ~16625–16645: only branches that send one template key (no combined message).

**Steps:** Migrate in order:
- `ERR_DRAFT_FINALIZE_FAILED`
- `ASK_UNIT` (nextStage === "UNIT")
- `TICKET_CREATED_COMMON_AREA`
- `ASK_WINDOW_SIMPLE` (with dayLine / baseVars)
- `MULTI_CREATED_CONFIRM` (and any other multi-issue template-only reply)

Use correct **deliveryPolicy** per call: NO_HEADER for `replyNoHeader_(...)`, DIRECT_SEND for `reply_(...)`.

---

## Phase 3b: Post-finalize — combined / precomputed messages ✅ Done (via Phase 7)

**Goal:** Flows that use `result.summaryMsg`, `combined`, or other precomputed strings. Do **not** mix with 3a; do after 3a is stable.

**Scope:** e.g. `combined = result.summaryMsg || renderTenantKey_("ASK_WINDOW_SIMPLE", ...); replyNoHeader_(combined)`. These require either a restricted `preRenderedBody` path (Phase 7) or a semantic intent that Outgate renders from facts. Document and implement in Phase 7 with strict rules.

**Implemented in Phase 7 (Option A):** All post-finalize combined/precomputed sends now go through `dispatchOutboundIntent_` with allowlisted intent types and `preRenderedBody`. See Phase 7 section for allowlist and call sites.

---

## Phase 4: Schedule and confirm context (ASK_WINDOW_*, CONFIRM_*) ✅ Done

**Goal:** All schedule-window asks and confirm-context messages go through Outgate.

**Template keys:**  
`ASK_WINDOW_SIMPLE`, `ASK_WINDOW`, `ASK_WINDOW_WITH_DAYHINT`, `ASK_WINDOW_DAYLINE_HINT`, `CONFIRM_WINDOW_*`,  
`CONFIRM_CONTEXT_NEEDS_CONFIRM`, `CONFIRM_CONTEXT_YESNO_REPROMPT`, `CONFIRM_CONTEXT_MISMATCH`, `CONFIRM_WINDOW_SET`.

**Steps:**
1. Migrate **by subcluster**, not whole phase at once — easier to debug:
   - First: all `CONFIRM_CONTEXT_*`
   - Then: all `CONFIRM_WINDOW_*`
   - Then: all `ASK_WINDOW_*`
2. For branches that build a message from multiple parts (e.g. dayLine + ASK_WINDOW_SIMPLE), keep passing the same vars so Outgate produces the same string. Set deliveryPolicy correctly (DIRECT_SEND vs NO_HEADER) per call site.

**Risk:** Medium; many branches. Subcluster order keeps changes contained.

**Phase 4 catch-up (found during audit):**
- **CONF_WINDOW_SET** (and tone keys: TICKET_CONFIRM_URGENT, etc.) — schedule confirmation after window set. Was `replyNoHeader_(outMsg)` with no tag; **migrated** to `dispatchOutboundIntent_` so OUT_SMS shows tag.
- **VISIT_CONFIRM_MULTI** (~17128) — single-template confirm; currently `replyNoHeader_(confirmMsg)`. Optional: migrate to Outgate for tag + channel (do with Phase 5 or later).
- **verdict.key** (schedule policy deny, ~17059, ~17176) — dynamic key; could migrate to `dispatchOutboundIntent_` with intentType/templateKey = verdict.key (Phase 5 or 7).

---

## Phase 5: Emergency and router / commands ✅ Done

**Goal:** Emergency acks and tenant-facing commands use Outgate.

**Template keys:**  
`EMERGENCY_CONFIRMED_DISPATCHED`, `EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID`, `EMERGENCY_ACK_RECEIVED`, `EMERGENCY_UPDATE_ACK`;  
`TENANT_RESET_OK`, `TENANT_OPTIONS_MENU`, `SMS_HELP`, `SMS_STOP_CONFIRM`, `SMS_START_CONFIRM`, `TENANT_ACK_NO_PENDING`, `INTENT_PICK`, `ASK_PROPERTY_MENU`, `WELCOME`.

**Steps:**
1. Migrate emergency replies (call sites ~10636–10638, ~15954–15955, ~16253–16254, etc.). **Preserve all vars exactly** for emergency-with-ticket-id cases (e.g. `ticketId` in vars).
2. Migrate router/command replies (CMD_START_OVER, CMD_OPTIONS, CMD_HELP, INTENT_PICK, etc. per map §7).

**Risk:** Low; same pattern. Ensure recipientRef and vars match current behavior.

---

## Phase 6: Errors and fallbacks ✅ Done

**Goal:** All generic error and fallback tenant messages go through Outgate.

**Template keys:** `ERR_GENERIC_TRY_AGAIN`, `ERR_DRAFT_FINALIZE_FAILED`, `ERR_CRASH_FALLBACK`, and any other `ERR_*` used in reply_/replyNoHeader_.

**Steps:** Same replacement pattern. Prefer doing this after the "happy path" phases so error paths are consistent with the rest.

---

## Phase 7: Combined / custom body — legacy bridge only ✅ Done

**Goal:** Handle flows that today send a *computed* or *combined* message (e.g. `replyNoHeader_(result.summaryMsg)` or `replyNoHeader_(combined)`). **Mark explicitly:** this phase is a **legacy bridge**, not the final expression architecture. North Star remains: intent + facts + audience + channel + constraints → Outgate renders. Not: brain prebuilds final string → Outgate forwards it.

**Option A — preRenderedBody (strict rules):**  
If you add `preRenderedBody`, restrict it hard so it does not become an escape hatch that undermines the architecture:

- **Only allowed for:** (1) parity migration of legacy combined flows, (2) temporary bridge for already-computed summary text, (3) explicit allowlisted intent types.
- **Outgate must still require:** intentType, recipientType, recipientRef. The artifact remains a **real outbound intent**, not "send this string." No stuffing raw text without intent metadata.
- Use for Phase 3b-style call sites only; plan to replace with semantic intents (Option B) over time.

**Option B — semantic intents:**  
Introduce intents (e.g. `TICKET_CREATED_ASK_SCHEDULE`) and have Outgate render the full message from facts (template or future AI). Do after Phases 1–6 and 7 Option A are solid.

**Recommendation:** Use Option A with the restrictions above for parity; then migrate toward Option B for the real North Star.

**Phase 7 implemented (Option A):**
- **OUTGATE.gs:** Added `OG_PRE_RENDERED_ALLOWLIST_` and `ogPreRenderedAllowlisted_()`. When intent has `preRenderedBody` and `intentType` is in the allowlist, dispatch accepts it (templateKey optional, defaulted to intentType) and `ogRenderIntent_` returns the trimmed preRenderedBody. Still requires intentType, recipientType, recipientRef.
- **Allowlisted intent types:** MULTI_SUMMARY_ASK_SCHEDULE, SCHEDULE_DRAFT_MULTI_REASK, SCHEDULE_DRAFT_MULTI_FAIL, MULTI_ISSUE_COMBINED, MGR_CREATED_INTRO_ASK.
- **PROPERA MAIN.gs:** All 8 combined/precomputed send sites now call `dispatchOutboundIntent_` with `preRenderedBody` and the appropriate intentType; fallback to `replyNoHeader_(body)` if dispatch fails.

---

## Summary table

| Phase | Scope | Risk | Depends on |
|-------|--------|------|------------|
| 0 | Render parity foundation (channel + deliveryPolicy + lang + logging) | None | — |
| 1 | One ASK_UNIT (or single) call site | Low | Phase 0 |in
| 2 | All ASK_UNIT, ASK_UNIT_GOT_PROPERTY, ASK_ISSUE_GENERIC | Low | Phase 1 |
| 3a | Post-finalize single-template replies only | Low–medium | Phase 2 |
| 3b | Post-finalize combined/precomputed ✅ Done (via Phase 7) | — | Phase 3a |
| 4 | ASK_WINDOW_*, CONFIRM_* (by subcluster) | Medium | Phase 3a |
| 5 | Emergency + router/commands | Low | Phase 4 |
| 6 | ERR_* and fallbacks | Low | Phase 5 |
| 7 | Combined/custom body (legacy bridge, strict preRenderedBody) ✅ Done | Medium | Phase 6 |

---

## What we do *not* do (guardrails)

- Do **not** change `compileTurn_`, `resolveEffectiveTicketState_`, `draftDecideNextStage_`, or `finalizeDraftAndCreateTicket_` logic; only change *how* the chosen message is sent and **per channel** (SMS vs WA vs voice) and **per presentation** (deliveryPolicy).
- Do **not** add a second outbound stack; all migrated paths use `dispatchOutboundIntent_` → channel- and deliveryPolicy-aware render → `ogDeliver_` → send.
- Do **not** let render channel and delivery channel drift: intent.channel (or resolved equivalent) must drive both render and delivery.
- Do **not** send the same message body for SMS and WhatsApp: SMS has compliance footer where required; WA has no footer; WA can be richer.
- Do **not** use SMS/WA body as voice output; voice stays on ALEXA_* and `outgateBuildAlexaReply_`.
- Do **not** leave fallback branches (`else { reply_(...) }`) in production after pilot verification; remove immediately when stable.
- Do **not** use `preRenderedBody` (if added) as a general escape hatch; restrict to legacy bridge and allowlisted intents; always require intentType, recipientType, recipientRef.
- Do **not** migrate Lifecycle outbound (TENANT_VERIFY_RESOLUTION, STAFF_UPDATE_REMINDER, etc.); they already use `dispatchOutboundIntent_` (and should pass channel when applicable).

---

## Rollback per phase

Each phase is a set of call-site replacements. Rollback = revert that commit or re-add the `reply_(renderTenantKey_(...))` branch behind a flag and switch the flag. No schema or resolver changes; rollback is local to PROPERA MAIN.gs (and optional OUTGATE.gs if you add `preRenderedBody` in Phase 7). When rolling back, ensure deliveryPolicy and channel are restored to previous behavior.

---

*This plan follows PROPERA_OUTGATE_EXPRESSION_MAP.md: brain outputs structured intent; Outgate owns expression and **channel-aware + presentation-aware rendering** (SMS + footer, WA no footer / richer, voice separate).*

**Next step (semantic intents):** See [PROPERA_SEMANTIC_INTENT_MIGRATION_PLAN.md](PROPERA_SEMANTIC_INTENT_MIGRATION_PLAN.md) — migrate from "template key + body" to "semantic meaning only" (e.g. TICKET_CREATED_ASK_SCHEDULE, CONFIRM_RECORDED_SCHEDULE); Outgate derives template from intent + facts.
