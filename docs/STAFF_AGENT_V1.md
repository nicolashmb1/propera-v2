# Staff Agent V1 — portal command contract

**Status:** Phase 2 foundation (page context envelope + existing staff lifecycle / cost paths).

**Related:** [PROPERA_JARVIS_NORTH_STAR.md](./PROPERA_JARVIS_NORTH_STAR.md) (§ Operational Scope), [OPERATIONAL_POLICY_CONFIG.md](./OPERATIONAL_POLICY_CONFIG.md)

---

## Operational Scope

Portal `portal_page_context` feeds the shared scope compiler (`src/agent/operationalScope/compileOperationalScope.js`). The envelope is the **anchor** slice only — not full situational truth. Jarvis Ask/Plan paths compile scope before reads or proposals; lifecycle/cost paths may use the same compiler as they converge.

---

## Transport

`propera-app` → `POST /api/portal/command` → V2 `POST /webhooks/portal` with `action: portal_chat`.

Modes: `staff_capture` (default `#` prefix), `normal`, `cost` (`$$` prefix), `jarvis_ask` (read-only Ask — no `#` / lifecycle).

---

## Context envelope (`portal_page_context`)

Optional JSON hint from the cockpit — **not authoritative**.

| Field | Purpose |
|-------|---------|
| `surface` | e.g. `tickets` |
| `pathname` | current route |
| `property_code` | pinned property |
| `unit` | pinned unit |
| `ticket_row_id` | `tickets.id` UUID |
| `human_ticket_id` | display id |
| `ticket_label` | short issue label |

V2 reads via `readPortalPageContext` (`src/agent/contextEnvelope.js`).

When the body uses deictic references ("schedule this ticket"), `resolveWorkItemFromPageContext` may pick the pinned ticket **before** generic WI resolution. Brain still validates lifecycle and policy.

---

## Proposal types (staff Phase 2 scope)

Implemented today via existing brain paths:

| Intent | Path |
|--------|------|
| Lifecycle (close, schedule, parts, note) | `handleStaffLifecycleCommand` |
| Cost capture | `staffExpenseCapture` + confirm token |

Structured proposal types (`coordinate_schedule_with_tenant`, etc.) remain Jarvis Phase 2+; this doc locks the **envelope** so new proposals share the same ingress.

---

## Guardrails

1. Page context is a hint — brain confirms ticket + permission.
2. No second brain — agent does not write case or ticket truth without validation.
3. Outbound messages still use Outgate / canonical send paths.
