# Propera System Map

**Purpose:** Single entry point for new contributors. Use this doc to find where doctrine, contracts, and domain details live. No code here — only pointers and a one-page view of the system.

---

## 1. Doctrine and contract docs (what to read when)

| Document | Purpose | Read when |
|----------|---------|-----------|
| **PROPERA_NORTH_COMPASS.md** | Mission, philosophy, layers, “who owns the next action.” | Understanding why the system is built this way; making design decisions. |
| **PROPERA_GUARDRAILS.md** | Non-negotiable implementation rules: AI vs engine, signals, resolver, lifecycle, locks, audit. | Before changing any behavior; every patch must comply. |
| **PROPERA_SYSTEM_SUMMARY.md** | Current architecture of PROPERA MAIN.gs: entry points, SMS flow, engines, execution flow, Compass layers, data model. | Understanding the main script and request flow. |
| **FILE_SPLIT_MAP.md** | Map of ~20K-line MAIN into logical sections and proposed file split. | Locating code by domain; planning refactors. |
| **PROPERA_DATA_CONTRACT.md** | Sheets: name, purpose, key columns, who reads/writes, invariants. | Reasoning about data, performance, and ownership. |
| **EMERGENCY_FLOW.md** | Definition of emergency, rules, where it lives, checklist. | Any change that might touch safety, scheduling, or lifecycle. |
| **LIFECYCLE_TIMER_AND_POLICY_SECTIONS.md** | Lifecycle timers, policy keys, PolicyTimers schema, ppGet_, contact-hour behavior. | Working on LIFECYCLE_ENGINE.gs or PolicyTimers. |
| **OUTGATE_V1_CODE_REFERENCE.md** | Outgate V1 contract; lifecycle outbound intents. | Working on messaging or Outgate. |
| **STAFF_CAPTURE_AND_RESIDENT_EXTRACTION.md** | Staff capture and resident extraction flows. | Working on #staff capture or resident flows. |

---

## 2. One-page view: layers and entry points

```
Signal Layer          Twilio SMS, Portal API, timers, webhooks
        ↓
Context / Compiler    compileTurn_, evaluateEmergencySignal_, normalizeInboundEvent_
        ↓
Responsibility        resolveWorkItemAssignment_, resolver, staff/contact identity
        ↓
Policy Engine         PropertyPolicy (ppGet_), ActionPolicy, lifecycle policy
        ↓
Lifecycle             handleLifecycleSignal_, wiEnterState_, lifecycleWriteTimer_
        ↓
Communication         dispatchOutboundIntent_, Outgate, renderTenantKey_, sendRouterSms_
        ↓
Expression            Templates, AI-assisted messaging (expression only)
        ↓
Operational Memory    PolicyEventLog, audit, logs
```

**Main entry points**

| Entry | File / area | What it does |
|-------|-------------|--------------|
| **doPost / doGet** | PROPERA MAIN.gs (M1 Gateway) | Routes by path → Portal API or Twilio SMS. |
| **handleSmsRouter_** | PROPERA MAIN.gs (M2 Router) | Single SMS dispatcher: compliance, lanes, #staff capture, amenity/leasing, core. |
| **handleSmsCore_** | PROPERA MAIN.gs (M3 Core) | Maintenance spine: compileTurn → draft → resolver → stage handlers → finalize. |
| **handleLifecycleSignal_** | LIFECYCLE_ENGINE.gs | Single lifecycle gateway: ACTIVE_WORK_ENTERED, STAFF_UPDATE, TIMER_FIRE, TENANT_REPLY. |
| **dispatchOutboundIntent_** | OUTGATE.gs | All outbound messaging for migrated paths. |

**Rule:** Do not bypass the resolver or the lifecycle engine. All operational actions go through these paths.

---

## 3. Where to go next by domain

- **Maintenance intake, draft, finalize, tickets** → PROPERA_SYSTEM_SUMMARY.md §3–5; FILE_SPLIT_MAP.md; PROPERA MAIN.gs (M3–M7).
- **Emergency detection and flow** → EMERGENCY_FLOW.md; PROPERA MAIN.gs (evaluateEmergencySignal_, isEmergencyContinuation_, latchEmergency_).
- **Lifecycle, timers, contact hours** → LIFECYCLE_ENGINE.gs; LIFECYCLE_TIMER_AND_POLICY_SECTIONS.md.
- **Policy (property, actions)** → PROPERA MAIN.gs (ppGet_, PropertyPolicy); POLICY_ENGINE.gs; LIFECYCLE_TIMER_AND_POLICY_SECTIONS.md.
- **Sheets and data** → PROPERA_DATA_CONTRACT.md; PROPERA_SYSTEM_SUMMARY.md §5.
- **Messaging and Outgate** → OUTGATE_V1_CODE_REFERENCE.md; PROPERA MAIN.gs (M8 Messaging).
- **Staff capture** → STAFF_CAPTURE_AND_RESIDENT_EXTRACTION.md; PROPERA_GUARDRAILS.md (do not touch canonical # STAFF CAPTURE without approval).

---

## 4. Patch workflow (guardrails)

1. Read **PROPERA_GUARDRAILS.md** and confirm the change does not violate any rule.
2. Identify the **module** (and allowed zone) for the change; prefer single-module patches.
3. If the change touches **lifecycle, timers, or emergency** → read **EMERGENCY_FLOW.md** and **LIFECYCLE_TIMER_AND_POLICY_SECTIONS.md**.
4. If the change touches **sheets or shared state** → check **PROPERA_DATA_CONTRACT.md** and lock discipline.
5. Follow the project’s PATCH format and risk check if one is defined.

---

*Last updated: system map added for documentation consolidation.*
