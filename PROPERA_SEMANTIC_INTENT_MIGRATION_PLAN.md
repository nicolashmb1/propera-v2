# Propera Semantic Intent Migration — Phased Execution Plan

**Reference:** [PROPERA_OUTGATE_MAP_EXECUTION_PLAN.md](PROPERA_OUTGATE_MAP_EXECUTION_PLAN.md) (completed), [PROPERA_OUTGATE_EXPRESSION_MAP.md](PROPERA_OUTGATE_EXPRESSION_MAP.md).  
**North Star:** Brain outputs **semantic meaning** (intent + facts); Outgate owns **expression** (which template, phrasing, channel adaptation). No more "send ASK_WINDOW_SIMPLE" or "send this prebuilt string" from the brain — instead: "TICKET_CREATED_ASK_SCHEDULE" with facts; Outgate decides how to say it.

---

## Goal

Move from:

- **Today:** Brain sends `intentType` + `templateKey` (+ vars) or `preRenderedBody`. Brain is still "template-key + exact body" thinking.
- **Target:** Brain sends **semantic intent** + **facts** only. Outgate maps intent → template(s) and renders. Same intent can later be expressed by different templates or AI without changing the brain.

**Principle:** The brain answers *what we mean* (e.g. "confirm schedule recorded", "ask for schedule window after ticket created"). Outgate answers *how we say it* (which template, which wording, SMS vs WA, footer, etc.).

**Definition of done (per intent):** A semantic intent is **migrated** when the call site no longer passes `templateKey` or `preRenderedBody`, and Outgate resolves the final template from `intentType` + `vars`. That is the finish line for each phase.

---

## Semantic Intent Contract (target)

Brain sends:

```javascript
{
  intentType: "TICKET_CREATED_ASK_SCHEDULE",   // semantic only
  recipientType: "TENANT",
  recipientRef: phone,
  lang: "en",
  channel: "SMS" | "WA",
  deliveryPolicy: "NO_HEADER" | "DIRECT_SEND",
  vars: { propertyName, unit, ticketId, dayWord?, ... },  // facts only
  meta: { source, stage, flow }
}
```

- **No `templateKey`** from brain (or only as optional override during migration; default = Outgate derives from intentType).
- **No `preRenderedBody`** from brain for these intents; Outgate composes from intent + vars.

**Vars: three levels (keep "facts only" precise)**

| Level | Purpose | Examples | Notes |
|-------|---------|----------|--------|
| **Facts** | Operational data the message refers to | propertyName, unit, ticketId, dayWord, accessNotes, label, dirPropertyName, dbUnit | Always allowed. Pure meaning. |
| **Selection hints** | Help Outgate choose template/variant (no wording) | afterCreate, urgent, hasPropertyName | Allowed during migration. Must come from upstream (policy/facts), not Outgate inference. |
| **Legacy bridge fields** | Temporary migration; prebuilt or key-like | confirmKey, summaryText, managerIntro | **Temporary.** Use only until semantic render path exists. Prefer moving to facts + selection hints. |

Document any new vars as one of these; mark legacy bridge as temporary so "facts only" stays clear in practice.

Outgate:

- Resolves `intentType` → template key(s) via an **intent–template map** (or single template per intent at first).
- Renders using existing `renderTenantKey_` (and later: richer logic or AI).
- Delivers as today (channel, deliveryPolicy, logging).

---

## Semantic Intent Catalog (staged)

Canonical semantic intent types and the facts they carry. Outgate will map each to one or more template keys.

| Semantic intent | Meaning | Facts (vars) | Current template key(s) (Outgate map) |
|-----------------|--------|--------------|--------------------------------------|
| **TICKET_CREATED_ASK_SCHEDULE** | Ticket created; ask tenant for a schedule window | Facts: propertyName, unit?, ticketId?, dayWord?, dayLine?. Selection hints: afterCreate. Legacy: summaryText, managerIntro (Phase 6 bridge) | ASK_WINDOW_SIMPLE, ASK_WINDOW_AFTER_CREATE, ASK_WINDOW_WITH_DAYHINT, ASK_WINDOW_DAYLINE_HINT |
| **CONFIRM_RECORDED_SCHEDULE** | Schedule confirmed and recorded; optional ticket id | ticketId, label; confirmKey (legacy bridge, upstream only — Outgate must not infer urgency) | CONF_WINDOW_SET, TICKET_CONFIRM_URGENT, etc. |
| **ASK_FOR_MISSING_UNIT** | We have property; need unit from tenant | propertyName?, propertyCode? | ASK_UNIT, ASK_UNIT_GOT_PROPERTY |
| **CONFIRM_CONTEXT_MISMATCH** | Confirm step: directory vs tenant DB mismatch | dirPropertyName, dirUnit, dbPropertyName, dbUnit | CONFIRM_CONTEXT_MISMATCH |
| **CONFIRM_CONTEXT_NEEDS_CONFIRM** | Confirm step: show context, ask yes/no | dbPropertyName, dbUnit | CONFIRM_CONTEXT_NEEDS_CONFIRM |
| **CONFIRM_CONTEXT_YESNO_REPROMPT** | Confirm step: reprompt yes/no | dbPropertyName, dbUnit | CONFIRM_CONTEXT_YESNO_REPROMPT |
| **TICKET_CREATED_COMMON_AREA** | Ticket created (common area); ack only | ticketId | TICKET_CREATED_COMMON_AREA |
| **ASK_FOR_ISSUE** | Ask tenant to describe the issue | (baseVars) | ASK_ISSUE_GENERIC |
| **ASK_PROPERTY_CHOICE** | Ask tenant to pick property (menu) | (baseVars) | ASK_PROPERTY_MENU / ASK_WINDOW_SIMPLE in property flow |
| **MULTI_CREATED_CONFIRM** | Multi-issue tickets created; confirm + next | count, when, (baseVars) | MULTI_CREATED_CONFIRM |
| **SCHEDULE_DRAFT_REASK** | Schedule draft: re-ask for window (e.g. from note) | accessNotes? | CONFIRM_WINDOW_FROM_NOTE / ASK_WINDOW_SIMPLE |
| **SCHEDULE_DRAFT_FAIL** | Schedule draft: finalize failed; re-ask | accessNotes? | CONFIRM_WINDOW_FROM_NOTE / ASK_WINDOW_SIMPLE |
| **ERROR_TRY_AGAIN** | Generic error; ask to try again | — | ERR_GENERIC_TRY_AGAIN |
| **ERROR_NO_PROPERTIES** | No properties configured | — | ERR_NO_PROPERTIES_CONFIGURED |
| **ERROR_LOST_REQUEST** | Lost open request / recovery fail | — | ERR_LOST_OPEN_REQUEST |
| **ERROR_CRASH_FALLBACK** | Crash fallback message | — | ERR_CRASH_FALLBACK |
| **ERROR_DRAFT_FINALIZE_FAILED** | Draft finalize failed | — | ERR_DRAFT_FINALIZE_FAILED |
| **EMERGENCY_CONFIRMED** | Emergency acknowledged (no ticket id) | — | EMERGENCY_CONFIRMED_DISPATCHED |
| **EMERGENCY_CONFIRMED_WITH_TICKET** | Emergency acknowledged with ticket id | ticketId | EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID |
| **EMERGENCY_UPDATE_ACK** | Emergency update ack | — | EMERGENCY_UPDATE_ACK |
| **TENANT_ACK_NO_PENDING** | Tenant ack when no pending work | — | TENANT_ACK_NO_PENDING |
| **SHOW_HELP** | Help / options intro | — | HELP_INTRO |
| **SHOW_OPTIONS** | Intent pick / options menu | — | INTENT_PICK |
| **DUPLICATE_REQUEST_ACK** | Duplicate request ack | — | DUPLICATE_REQUEST_ACK |
| **CLEANING_WORKITEM_ACK** | Cleaning work item ack | — | CLEANING_WORKITEM_ACK |
| **SCHEDULE_POLICY_DENY** | Schedule policy denied (dynamic message) | verdict key / policy reason | verdict.key (dynamic template) |
| **VISIT_CONFIRM** | Visit confirmation (single template) | (vars) | VISIT_CONFIRM_MULTI |

**PreRenderedBody legacy intents (to be replaced by semantic + facts):**

| Current (Phase 7 bridge) | Becomes (semantic) | Notes |
|--------------------------|--------------------|-------|
| MULTI_SUMMARY_ASK_SCHEDULE (preRenderedBody) | TICKET_CREATED_ASK_SCHEDULE | vars.summaryText or Outgate builds from facts |
| SCHEDULE_DRAFT_MULTI_REASK (preRenderedBody) | SCHEDULE_DRAFT_REASK | vars.accessNotes; Outgate renders |
| SCHEDULE_DRAFT_MULTI_FAIL (preRenderedBody) | SCHEDULE_DRAFT_FAIL | vars.accessNotes; Outgate renders |
| MULTI_ISSUE_COMBINED (preRenderedBody) | TICKET_CREATED_ASK_SCHEDULE | summary in vars; Outgate composes |
| MGR_CREATED_INTRO_ASK (preRenderedBody) | TICKET_CREATED_ASK_SCHEDULE | manager path; vars.managerIntro? or Outgate uses MGR_CREATED_TICKET_INTRO + ASK_WINDOW |

---

## Phase 0: Outgate intent–template map (foundation) ✅ Completed

**Goal:** Outgate can satisfy a request using **only** `intentType` + `vars` (no `templateKey`). Backward compatible: if `templateKey` is provided, use it; otherwise derive from intentType.

**Steps:**

1. **Add intent–template map in OUTGATE.gs**  
   - Data structure: for each semantic intentType, default template key(s). Example: `TICKET_CREATED_ASK_SCHEDULE` → `ASK_WINDOW_SIMPLE` (Phase 1 can add logic for dayLine / afterCreate).
   - Function: `ogResolveTemplateKey_(intent)` → returns templateKey. If `intent.templateKey` is non-empty, return it. Else if intentType is in map, return map[intentType]. Else return "" (dispatch will fail as today).

2. **Change dispatch validation**  
   - Allow `templateKey` to be missing when intentType is in the semantic map. Validation: require intentType + (templateKey OR intentType in map).

3. **Change ogRenderIntent_**  
   - When templateKey is empty, set it from `ogResolveTemplateKey_(intent)` before rendering. So render path always has a template key (either from brain or from map).

4. **Template-source logging (observability)**  
   - For every resolved template, log **template source** so migration can be verified:
     - **`templateSource: "explicit"`** — brain passed templateKey; use it as-is.
     - **`templateSource: "semantic_map"`** — no templateKey; resolved from intent–template map by intentType.
     - **`templateSource: "dynamic_logic"`** — resolved by Outgate logic from intentType + vars (e.g. dayWord → ASK_WINDOW_WITH_DAYHINT).
   - Log at least: `intentType`, `resolvedTemplateKey`, `templateSource`. (Equivalent to OUTGATE_TEMPLATE_EXPLICIT vs OUTGATE_TEMPLATE_RESOLVED; one structured log is enough.)
   - This distinguishes brain-template-driven sends from truly semantic sends during rollout.

**Deliverable:** Brain can send `intentType: "CONFIRM_RECORDED_SCHEDULE"` with no templateKey; Outgate resolves to CONF_WINDOW_SET (or tone variant) and renders. Existing call sites that still pass templateKey keep working. Logs show whether each send used explicit template or semantic resolution.

**Risk:** Low. Additive; no call-site changes in Phase 0.

---

## Phase 1: Schedule confirmation (CONFIRM_RECORDED_SCHEDULE) ✅ Completed

**Goal:** All schedule-confirmation sends use semantic intent only. Brain sends `CONFIRM_RECORDED_SCHEDULE` + vars (ticketId, label; confirmKey only as legacy bridge if needed). No templateKey, no preRenderedBody.

**Scope:** Call sites that today send CONF_WINDOW_SET, TICKET_CONFIRM_URGENT, or similar after schedule is set.

**Rule — urgency and template variant:**  
**AI / Outgate must not determine urgency.** Any confirm-template variant choice based on urgency (e.g. TICKET_CONFIRM_URGENT vs CONF_WINDOW_SET) must come **only** from:
- explicit upstream fact (e.g. policy output, resolved urgency flag), or  
- approved upstream decision passed in vars (e.g. confirmKey from brain).  

Never from Outgate inference or interpretation. Expression must not mutate operational truth.

**Steps:**

1. Add map entries: `CONFIRM_RECORDED_SCHEDULE` → default `CONF_WINDOW_SET`; optional: vars.confirmKey (legacy bridge) for alternate template when upstream explicitly provides it.
2. In PROPERA MAIN.gs, find every dispatch that uses templateKey CONF_WINDOW_SET / _confirmKey for schedule confirm. Replace with intentType `CONFIRM_RECORDED_SCHEDULE`, vars only (ticketId, label; confirmKey only when upstream sets it). No templateKey from brain for default path.
3. Outgate: ogResolveTemplateKey_ for CONFIRM_RECORDED_SCHEDULE uses vars.confirmKey when present (explicit upstream), else CONF_WINDOW_SET.

**Risk:** Low. Single cluster; easy to verify.

---

## Phase 2a: Ask schedule — plain variants (TICKET_CREATED_ASK_SCHEDULE) ✅ Completed

**Goal:** “Ask for schedule window” sends use semantic intent `TICKET_CREATED_ASK_SCHEDULE` + facts. Outgate picks **plain** template first: ASK_WINDOW_SIMPLE, ASK_WINDOW, optionally ASK_WINDOW_AFTER_CREATE. No day-hint logic yet.

**Scope:** Call sites that today send ASK_WINDOW_SIMPLE, ASK_WINDOW, ASK_WINDOW_AFTER_CREATE (without day-hint variants).

**Steps:**

1. Add map / logic: `TICKET_CREATED_ASK_SCHEDULE` → default ASK_WINDOW_SIMPLE; if vars.afterCreate use ASK_WINDOW_AFTER_CREATE; else ASK_WINDOW or ASK_WINDOW_SIMPLE per existing behavior.
2. Replace those call sites with intentType `TICKET_CREATED_ASK_SCHEDULE`, vars only (propertyName, unit, ticketId, afterCreate). No templateKey.
3. Ensure deliveryPolicy and channel are still set per call site.

**Risk:** Low–medium. Stabilize basic semantic schedule-ask first.

---

## Phase 2b: Ask schedule — hinted variants (TICKET_CREATED_ASK_SCHEDULE) ✅ Completed

**Goal:** Add **hinted** schedule-ask variants so Outgate can choose ASK_WINDOW_WITH_DAYHINT, ASK_WINDOW_DAYLINE_HINT from vars (dayWord, dayLine). Expression logic becomes more nuanced here.

**Scope:** Call sites that today send ASK_WINDOW_WITH_DAYHINT, ASK_WINDOW_DAYLINE_HINT, or ASK_WINDOW_SIMPLE with dayLine.

**Steps:**

1. Extend ogResolveTemplateKey_ (or dynamic logic) for `TICKET_CREATED_ASK_SCHEDULE`: when vars.dayWord or vars.dayLine present, resolve to ASK_WINDOW_WITH_DAYHINT or ASK_WINDOW_DAYLINE_HINT (or render ASK_WINDOW_SIMPLE with dayLine in vars).
2. Replace those call sites with intentType `TICKET_CREATED_ASK_SCHEDULE`, vars including dayWord / dayLine. No templateKey.
3. Log templateSource `"dynamic_logic"` when template is chosen from day-hint vars.

**Risk:** Medium. Nuanced template choice; verify parity with current day-hint behavior.

**Reason for 2a/2b split:** Stabilize plain semantic schedule-ask first; then add hinted variants where expression logic is more complex.

---

## Phase 3: Ask unit (ASK_FOR_MISSING_UNIT) ✅ Completed

**Goal:** All “ask for unit” sends use semantic intent `ASK_FOR_MISSING_UNIT`. Outgate maps to ASK_UNIT or ASK_UNIT_GOT_PROPERTY from vars (e.g. has property name = use ASK_UNIT_GOT_PROPERTY).

**Scope:** Call sites that today send ASK_UNIT, ASK_UNIT_GOT_PROPERTY.

**Model intent:** ASK_FOR_MISSING_UNIT is the **reference semantic intent** for future design: one clear meaning (“we need the unit from the tenant”), facts only (propertyName, propertyCode), Outgate chooses expression. Use it as the pattern for new intents.

**Steps:**

1. Map: `ASK_FOR_MISSING_UNIT` → ASK_UNIT by default; if vars.propertyName (or similar) present, use ASK_UNIT_GOT_PROPERTY (or single template with vars).
2. Replace all ASK_UNIT / ASK_UNIT_GOT_PROPERTY dispatch call sites with intentType `ASK_FOR_MISSING_UNIT`, vars only. No templateKey.

**Risk:** Low.

---

## Phase 4: Confirm context (CONFIRM_CONTEXT_*) ✅ Completed

**Goal:** Confirm-context flows already use semantic-style names (CONFIRM_CONTEXT_MISMATCH, CONFIRM_CONTEXT_NEEDS_CONFIRM, CONFIRM_CONTEXT_YESNO_REPROMPT). Brain stops sending templateKey; only intentType + vars.

**Scope:** All CONFIRM_CONTEXT_* dispatch call sites.

**Steps:**

1. Map: each CONFIRM_CONTEXT_* intentType → same-name template key (1:1).
2. Remove templateKey from those call sites; pass only intentType + vars + deliveryPolicy.

**Risk:** Low. **Easy-win territory:** Phase 4 is low risk and high value (names already semantic). **Optional execution order:** If schedule-hint logic (2b) feels noisy, you can run 1 → 2a → 3 → 4 → 2b instead of 2a → 2b → 3 → 4; ASK_FOR_MISSING_UNIT is simpler and already proven. Current order (1, 2a, 2b, 3, 4) is fine.

---

## Phase 5: Remaining intents — grouped by expression complexity ✅ Completed

**Goal:** Migrate remaining template-key intents to semantic-only. Group by **expression complexity** so sensitive and policy-bound intents are handled with care.

**5a — Simple 1:1 (semantic → single template)**  
No branching; intentType maps to one template. Low risk.

- TICKET_CREATED_COMMON_AREA  
- ASK_FOR_ISSUE  
- MULTI_CREATED_CONFIRM  
- TENANT_ACK_NO_PENDING  
- DUPLICATE_REQUEST_ACK  
- CLEANING_WORKITEM_ACK  
- VISIT_CONFIRM  

**5b — Sensitive / policy-bound**  
Business meaning and correctness matter; template or wording may be policy-driven. Ensure variant choice comes from upstream facts/policy, not Outgate inference.

- **ERROR_*** — ERROR_TRY_AGAIN, ERROR_NO_PROPERTIES, ERROR_LOST_REQUEST, ERROR_CRASH_FALLBACK, ERROR_DRAFT_FINALIZE_FAILED; map to existing ERR_* templates.
- **EMERGENCY_*** — EMERGENCY_CONFIRMED, EMERGENCY_CONFIRMED_WITH_TICKET, EMERGENCY_UPDATE_ACK.
- **SCHEDULE_POLICY_DENY** — intentType + vars.verdictKey (or similar); Outgate maps to dynamic template; verdict must come from policy/upstream.

**5c — Navigation / menu**  
Help and options; simple 1:1 but distinct category.

- SHOW_HELP → HELP_INTRO  
- SHOW_OPTIONS → INTENT_PICK  

**Steps:**

1. Add all map entries in Outgate (5a, 5b, 5c).
2. Replace each cluster in PROPERA MAIN.gs: semantic intentType only, vars; no templateKey. Do 5a first, then 5c, then 5b if you want to isolate policy-sensitive sends.

**Risk:** Low–medium. Risk is not code shape but business meaning for 5b; keep upstream ownership of policy/urgency.

---

## Phase 6: Replace direct preRenderedBody with semantic intents + bounded vars ✅ Completed

**Goal:** **Remove direct preRenderedBody dispatch from the brain.** If legacy summary content must persist temporarily, pass it as **bounded structured vars** and let **Outgate own the final composed message**. Do not over-promise “no preRenderedBody” everywhere: for some flows the best intermediate step is semantic intent + a legacy fact-like field (e.g. summaryText) that Outgate wraps in final expression — still a big improvement over raw preRenderedBody.

**Scope:**

- **MULTI_SUMMARY_ASK_SCHEDULE** (preRenderedBody) → **TICKET_CREATED_ASK_SCHEDULE** with vars (e.g. summaryText as legacy bridge; Outgate composes final message from summary + ask template or single template). Eventually replace summaryText with facts so Outgate can build the summary.
- **SCHEDULE_DRAFT_MULTI_REASK** → **SCHEDULE_DRAFT_REASK** with vars.accessNotes; Outgate renders CONFIRM_WINDOW_FROM_NOTE or ASK_WINDOW_SIMPLE.
- **SCHEDULE_DRAFT_MULTI_FAIL** → **SCHEDULE_DRAFT_FAIL** with vars.accessNotes; same.
- **MULTI_ISSUE_COMBINED** → **TICKET_CREATED_ASK_SCHEDULE** with vars (summaryText or minimal facts); Outgate composes.
- **MGR_CREATED_INTRO_ASK** → **TICKET_CREATED_ASK_SCHEDULE** with vars (e.g. managerIntro as legacy bridge or flag); Outgate uses MGR_CREATED_TICKET_INTRO + ASK_WINDOW_SIMPLE or single template.

**Steps:**

1. Implement Outgate render path for each: from intent + vars only; **no preRenderedBody from brain.** Where needed, accept bounded vars (e.g. summaryText, managerIntro) as legacy bridge; Outgate owns wrapping and final composition.
2. In PROPERA MAIN.gs, replace every dispatch that uses preRenderedBody for these intents with semantic intent + vars only (vars may include legacy bridge fields temporarily).
3. Remove or shrink preRenderedBody allowlist in Outgate once no callers use it for these.

**Risk:** Medium. Touches combined-message logic; must preserve exact behavior or document intentional changes.

---

## Summary table

| Phase | Scope | Risk | Depends on | Status |
|-------|--------|------|------------|--------|
| 0 | Outgate intent–template map; templateKey optional; templateSource logging | Low | — | ✅ Completed |
| 1 | CONFIRM_RECORDED_SCHEDULE (schedule confirmation) | Low | Phase 0 | ✅ Completed |
| 2a | TICKET_CREATED_ASK_SCHEDULE — plain (ASK_WINDOW_SIMPLE, ASK_WINDOW, ASK_WINDOW_AFTER_CREATE) | Low–medium | Phase 0 | ✅ Completed |
| 2b | TICKET_CREATED_ASK_SCHEDULE — hinted (ASK_WINDOW_WITH_DAYHINT, ASK_WINDOW_DAYLINE_HINT) | Medium | Phase 0, 2a | ✅ Completed |
| 3 | ASK_FOR_MISSING_UNIT (model intent) | Low | Phase 0 | ✅ Completed |
| 4 | CONFIRM_CONTEXT_* (no templateKey; easy-win) | Low | Phase 0 | ✅ Completed |
| 5 | 5a simple 1:1, 5b sensitive/policy-bound, 5c navigation | Low–medium | Phase 0 | ✅ Completed |
| 6 | Remove direct preRenderedBody; semantic + bounded vars; Outgate owns composition | Medium | Phases 1–5 | ✅ Completed |

---

## Acceptance checklist (per phase)

Use this checklist for each phase before marking it complete. Keeps rollout disciplined.

- [ ] **No duplicate outbound** — one semantic dispatch per logical send; no double reply.
- [ ] **Correct resolved template** — Outgate resolves to the same template (or intended variant) the call site used before, unless the phase explicitly changes behavior.
- [ ] **Correct templateSource** — Logs show `templateSource: "semantic_map"` or `"dynamic_logic"` (not only `"explicit"`) for migrated call sites.
- [ ] **Same user-visible behavior** unless the phase intentionally changes wording or flow.
- [ ] **Correct channel behavior** — SMS vs WA unchanged; footer and delivery match intent channel.
- [ ] **Correct deliveryPolicy** — DIRECT_SEND vs NO_HEADER unchanged per call site.
- [ ] **No stage/state behavior change** — Resolver, lifecycle, and draft logic unchanged; only how the chosen message is sent.

---

## Guardrails

- Do **not** change resolver, lifecycle, or draft logic; only what the brain sends to Outgate and how Outgate resolves template/key.
- Keep **one** outbound path: `dispatchOutboundIntent_` → resolve template (map or explicit) → render → deliver.
- **Backward compatibility:** During migration, Outgate continues to accept templateKey; if present, use it. Semantic map is used only when templateKey is missing. Zero forced rewrites; old and new worlds coexist until each phase is proven.
- **Logging:** Log intentType, resolvedTemplateKey, and **templateSource** (`"explicit"` | `"semantic_map"` | `"dynamic_logic"`) so every send is auditable and you can see whether it was brain-template-driven or truly semantic. One of the most useful observability additions for migration.
- **Channel and deliveryPolicy:** Still required from brain (or defaults); no change to channel/footer behavior.
- **Urgency / policy:** Outgate must not infer urgency or policy; any template variant based on urgency or policy must come from explicit upstream fact or policy output.

---

## Rollback

Per phase: revert the call-site and/or Outgate map changes for that phase. No schema or resolver changes. Restoring templateKey in call sites restores old behavior as long as Outgate still accepts it.

---

*This plan moves the system to semantic intent–first outbound: brain sends meaning, Outgate owns expression. After Phase 6, the brain no longer sends template keys or direct preRenderedBody for these flows; where legacy content persists it is passed as bounded vars and Outgate composes the final message.*

**What this enables:** The brain stops thinking in template names and starts thinking in operational meaning. Outgate becomes the place that turns meaning into communication. That is the real prerequisite for smarter replies, better tone, channel-specific expression, future AI polishing, and a later personality/Jarvis layer. Once core intents are fully semantic, AI can be added as a **constrained expression step** only:

```
brain → semantic intent + facts
  → Outgate selects expression strategy (template or AI polish)
  → channel adaptation
  → delivery
```

Intent + facts + channel + audience is the clean interface a safe expression layer needs.
