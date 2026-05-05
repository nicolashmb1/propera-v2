# Orchestrator routing (GAS `handleInboundRouter_` / `20_CORE_ORCHESTRATOR` slice)

**Code:** `src/inbound/runInboundPipeline.js` orchestrates I/O; **`src/inbound/routeInboundDecision.js`** holds **pure** route rules (Phase 20-A–C).

This document is the **reviewer-facing** map of **order**, **guards**, and **lane stubs**.

---

## 1. Execution order (fixed)

| Step | What runs | Notes |
|------|-----------|--------|
| 1 | `upsertTelegramChatLink` (Telegram only) | Transport shell |
| 2 | `resolveStaffContextFromRouterParameter` | Staff row + actor key |
| 3 | `evaluateRouterPrecursor` | `#` staff capture first; **any** identified staff → `STAFF_LIFECYCLE_GATE` (including **empty body**); else compliance / tenant commands |
| 4 | `normalizeInboundEventFromRouterParameter` | Canonical inbound event for lane |
| 5 | `buildLaneDecision` | Staff capture / staff gate **or** `decideLane(inbound)` |
| 6 | `appendEventLog` `LANE_DECIDED` | Flight recorder |
| 7 | `handleStaffLifecycleCommand` | Only if `STAFF_LIFECYCLE_GATE` **and** staff row exists |
| 8 | SMS compliance STOP/START/HELP | **Only** if `transportCompliance` says SMS + no staff run + keyword + `From` |
| 9 | SMS opt-out suppress check | Only if SMS + evaluated + not compliance + DB + opted out |
| 10 | **Lane stub** (vendor/system) | Phase **20-C** — if evaluated lane is not maintenance-eligible |
| 11 | `handleInboundCore` | Only if `computeCanEnterCore` is true |
| 12 | Outgate: `buildOutboundIntent` → `renderOutboundIntent` → `dispatchOutbound` | Single send seam |

**Ordering invariant (matches GAS intent):** staff lifecycle is evaluated **before** tenant SMS compliance so staff senders are not misclassified as compliance-only.

---

## 2. What blocks maintenance core (`handleInboundCore`)

`computeCanEnterCore` requires **all** of:

| Guard | Source |
|-------|--------|
| Lane allows maintenance | `laneAllowsMaintenanceCore(laneDecision)` — **tenantLane**, **managerLane**, or **staffCapture** |
| `CORE_ENABLED` | `coreEnabled()` |
| Postgres configured | `isDbConfigured()` |
| No staff handler result | `!staffRun` |
| No compliance reply | `!complianceRun` |
| Not SMS-suppressed | `!suppressedRun` |
| No SMS compliance keyword path | `!effectiveCompliance` (SMS STOP/START/HELP path) |
| No tenant command | `!precursor.tenantCommand` |
| Precursor allows core | `STAFF_CAPTURE_HASH` **or** `PRECURSOR_EVALUATED` |
| **Not staff tenant-intake** | `computeCanEnterCore`: if `staffContext.isStaff` and precursor is **not** `STAFF_CAPTURE_HASH` → **false** (staff never opens `handleInboundCore` in `TENANT` mode; non-`#` traffic is lifecycle / PM amend, not tenant lane) |

If any fails → core does not run.

---

## 3. Precursor outcomes vs core

| `precursor.outcome` | Core allowed? | Notes |
|---------------------|---------------|--------|
| `STAFF_LIFECYCLE_GATE` | No (unless you later add a path) | Staff command handled in step 7 |
| `STAFF_CAPTURE_HASH` | Yes (if other guards pass) | `#` strip → `MANAGER` mode |
| `PRECURSOR_EVALUATED` | Yes (if lane + guards pass) | Normal tenant/manager flow |
| Other | No | Router does not open core |

---

## 3b. Staff messaging without the app (SMS / WhatsApp / Telegram)

Identified **staff** never use tenant maintenance intake (see §2 staff guard); non-`#` text is handled **before** core in this order:

1. **PM-style ticket patch** — strict `Update PENN-MMDDYY-#### …` or deterministic **natural language** amend (`staffTicketAmendNl.js` + `portalTicketMutations.js`): unit, issue, status, urgency, **preferred window / schedule phrase** (parsed via **`applyPreferredWindowByTicketKey`** + **`afterTenantScheduleApplied`** — same as tenant schedule commit, not a raw string-only write), attachments, etc.
2. **`handleStaffLifecycleCommand`** — same WI resolution as always:
   - **Schedule:** natural language window after property/unit/issue context (e.g. “Friday afternoon”) → `SCHEDULE_SET` when parse + policy succeed.
   - **Status / done:** phrases like *done, complete, mark complete, wrapped up, all set* → `STAFF_UPDATE` / lifecycle.
   - **Parts / vendor / access / delayed** — existing keyword paths.

Use **`#`** only for **new staff capture** drafts; use plain text for lifecycle and ticket edits.

---

## 4. Lane stubs (Phase 20-C)

If `decideLane` returns **vendor** or **system** (`vendorLane`, `systemLane`), maintenance core is **not** entered. The user receives a **deterministic stub** (`buildNonMaintenanceLaneStub`) and `event_log` records **`LANE_STUB`**.

| Lane | Maintenance core | Stub `brain` |
|------|------------------|--------------|
| `tenantLane` | Allowed | — |
| `managerLane` | Allowed | — |
| `staffCapture` | Allowed | — |
| `vendorLane` | **Blocked** | `lane_stub_vendor` |
| `systemLane` | **Blocked** | `lane_stub_system` |
| `staffOperational` | N/A (precursor not `PRECURSOR_EVALUATED` for core) | — |

Vendor/system classification uses env lists in `src/config/lanePolicy.js` (`VENDOR_PHONE_LAST10_LIST`, `meta.source === aiq` for system).

---

## 5. Tests

| File | Covers |
|------|--------|
| `tests/routeInboundDecision.test.js` | Lane guards, `computeCanEnterCore`, stub helpers |
| `tests/evaluateRouterPrecursor.test.js` (or similar) | Precursor ordering vs compliance |

---

## Related

- `docs/GAS_ENGINE_PORT_PROGRAM.md` — engine **20** phases  
- `docs/PARITY_LEDGER.md` — §5 Router
