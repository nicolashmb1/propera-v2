# Operational Policy Config — layer doctrine

**Status:** **Doctrine + target architecture** — not a single shipped module yet. V2 today has **domain-specific** policy data (e.g. `property_policy` for schedule hours per [PROPERTY_POLICY_PARITY.md](./PROPERTY_POLICY_PARITY.md)). This doc defines the **unified configurable layer** all engines and Jarvis should converge on for multi-property, multi-company operation.

**Purpose:** Propera must work for **many properties and companies** without hardcoding rules in code. Operational doctrine — monitoring windows, notice tiers, approval thresholds, contact hours, delinquency triggers — lives in **editable config records**, resolved deterministically by the brain and logged for audit.

**Audience:** product, architecture, every engine owner (CME, maintenance, finance, communications, Jarvis).

**Related:**

- [PROPERA_JARVIS_NORTH_STAR.md](./PROPERA_JARVIS_NORTH_STAR.md) — brain assigns approval tiers; agent does not read raw config
- [CONFLICT_MEDIATION_ENGINE.md](./CONFLICT_MEDIATION_ENGINE.md) — consumes conflict.* keys
- [PROPERTY_POLICY_PARITY.md](./PROPERTY_POLICY_PARITY.md) — existing schedule-policy rows (precursor / partial implementation)
- [../propera-gas-reference/PROPERA_NORTH_COMPASS.md](../propera-gas-reference/PROPERA_NORTH_COMPASS.md)
- [../propera-gas-reference/PROPERA_GUARDRAILS.md](../propera-gas-reference/PROPERA_GUARDRAILS.md)

**Naming:** This is the **Operational Policy Config layer** (policy config). It is **not** the Conflict Mediation Engine. It is **not** the global brain "policy evaluation" code path — it is the **data + resolution contract** that evaluation reads.

---

## Core rule

**No operational rule that varies by company or property may be hardcoded in application logic.**

Constants in code are allowed only for:

- system invariants (e.g. enum values, max string lengths)
- safe global defaults used **only when** no config row exists — and those defaults must be documented and logged when applied

Everything else is **set, edited, versioned, and audited** through config records and portal UI (owner/PM), not developer deploys.

---

## Why this is a product architecture choice

AppFolio-class systems often bury rules in vendor logic. Changing "how many days before second notice" may require a support ticket.

Propera’s model: each operator configures **their** operational doctrine; the **brain enforces it deterministically** and records **which policy version** applied at decision time.

That supports:

- multi-tenant SaaS (many companies, many properties)
- legal defensibility ("rule X was in effect on date Y")
- Jarvis without prompt-stuffed rules (agent asks brain; brain resolves config)

---

## Scope hierarchy (inheritance)

Policies scope **downward**; resolution walks from most specific to least:

```text
Portfolio / organization (company default)
  ↓
Property (overrides portfolio)
  ↓
Unit (rare — e.g. ADA, specific lease rider)
```

**Resolution rule:** Use the **most specific applicable** active record for `(policy_key, as_of_date, context)`.

Example: Grand Management Group default `conflict.monitoring_window_days = 30`; property `PENN` override `14` → brain uses **14** for PENN, **30** for MORRIS if MORRIS has no override.

---

## What a policy record looks like (conceptual)

| Field | Role |
|-------|------|
| `policy_key` | Stable namespaced key, e.g. `conflict.monitoring_window_days` |
| `scope` | `portfolio` \| `property` \| `unit` |
| `org_id` / `property_code` / `unit_id` | Scope identifiers |
| `value` | Stored value (typed) |
| `value_type` | `integer`, `boolean`, `string`, `json`, `duration`, … |
| `label` | Human label for portal UI |
| `description` | Operator-facing help text |
| `effective_from` / `effective_to` | Optional; future-dated changes |
| `created_by` / `updated_by` | Audit |
| `version` or append-only **policy_change_log** | Who changed what, when |

When any brain decision uses a policy value, persist **`policy_record_id`** (or snapshot) on the case event / `event_log` payload so disputes can be reconstructed months later.

---

## How engines consume config

**Pattern (all engines):**

```text
brain.policy.resolve(policy_key, { org, property, unit, asOf })
  → { value, record_id, scope_used, defaulted: boolean }
```

- **Agent / Jarvis** does **not** read the config table directly.
- **Agent** proposes; **brain** resolves config and validates.
- **Domain engine** commits operational truth using resolved values.

Existing partial pattern: `getSchedPolicySnapshot` + `property_policy` for schedule validation — extend and generalize, do not duplicate per engine.

---

## Policy keys by domain (examples — not exhaustive)

### Conflict Mediation (`conflict.*`)

| Key | Example | Notes |
|-----|---------|--------|
| `conflict.monitoring_window_days` | `14` | Days in MONITORING before auto-escalation eligible |
| `conflict.notice_tier_sequence` | json | courtesy → second → formal → warning |
| `conflict.auto_escalate_after_violations` | `2` | Count in rolling window |
| `conflict.complainant_confidentiality` | `always` \| `on_request` \| `pm_decides` | Engine-enforced |

See [CONFLICT_MEDIATION_ENGINE.md](./CONFLICT_MEDIATION_ENGINE.md).

### Maintenance / scheduling (`sched.*`, `maintenance.*`)

| Key | Example |
|-----|---------|
| `sched.earliest_hour` / `sched.latest_hour` | Already partly in `property_policy` |
| `sched.allow_weekends` | boolean |
| `maintenance.tenant_contact_business_hours_only` | boolean |
| `maintenance.max_schedule_retries_before_pm` | integer |

Align with [PROPERTY_POLICY_PARITY.md](./PROPERTY_POLICY_PARITY.md) — migrate don’t fork.

### Finance (`finance.*`)

| Key | Example |
|-----|---------|
| `finance.delinquency_notice_threshold_days` | `30` |
| `finance.late_fee_enabled` | boolean |
| `finance.charge_confirm_threshold_cents` | amount → approval tier |

See [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md).

### Agent / approval (`agent.*`, `approval.*`)

| Key | Example |
|-----|---------|
| `approval.tier_by_action` | json map | brain-owned interpretation |
| `agent.max_outreach_attempts` | per workflow |
| `outgate.tone_profile` | per audience | expression layer |

Jarvis [approval tiers](./PROPERA_JARVIS_NORTH_STAR.md) are assigned by **brain policy**, using these keys where applicable.

---

## Portal (propera-app)

Policy config is **owner/PM editable** in the cockpit — not `.env` and not SQL-only.

| Need | Surface |
|------|---------|
| View defaults vs overrides | Property settings → Policies (or dedicated Policies nav) |
| Edit with validation | Type, range, dependency checks on save |
| Effective dating | Change applies from future date without rewriting open cases incorrectly |
| Audit | Who changed what, from → to |

`propera-app` edits config; `propera-v2` validates and stores; brain resolves at runtime.

---

## Relationship to existing V2 tables

| Today | Future |
|-------|--------|
| `property_policy` rows for schedule hours | Remain valid; keys align under `sched.*` namespace or mapped into unified `operational_policy` table |
| Ad hoc env flags (`PROPERA_*`) | Product/feature flags only — not per-property business rules |
| Hardcoded tiers in finance/cost capture | Move thresholds to `finance.*` / `approval.*` keys over time |

**Migration principle:** one resolution API; multiple storage backends during transition is acceptable; **multiple resolution logics** is not.

---

## Phased convergence (recommended)

| Phase | Scope |
|-------|--------|
| **PC-0** | This doc + North Compass reference |
| **PC-1** | Unified schema sketch + `brain.policy.resolve` contract (read-only); map `property_policy` — **started:** `src/brain/policy/resolveOperationalPolicy.js`; `conflict.*` GLOBAL seeds in migration `068` |
| **PC-2** | Portal read/edit for portfolio + property; audit log |
| **PC-3** | CME keys (`conflict.monitoring_window_days`, etc.) |
| **PC-4** | Finance + approval threshold keys |
| **PC-5** | Jarvis surfaces only call brain — never raw config |

---

## Guardrails

1. **Agents never own config truth** — no LLM-invented rules persisted as policy.
2. **Every resolved decision logs `record_id`** when a policy value governed the outcome.
3. **No hardcoded property names or company names** in rule logic ([PROPERA_GUARDRAILS.md](../propera-gas-reference/PROPERA_GUARDRAILS.md)).
4. **Effective dates** — past cases use policy as-of event time, not today's edit.
5. **Do not confuse** this layer with CME **conduct policy definitions** (quiet hours, trash rules text) — those are domain content records; **this layer** holds numeric/boolean/threshold **operational parameters** engines use. (Conduct policy *text* may live in CME tables; *parameters* like monitoring days live here.)

---

## Competitive framing (product potential)

Configurable operational doctrine per company, enforced consistently across maintenance, conflict, finance, and communications — with Jarvis as the conversational front — is a different architecture than static multi-tenant apps with vendor-owned rules.

This layer is what makes that claim technically true.

---

## Changelog

| Date | Note |
|------|------|
| 2026-05-26 | Initial doctrine — multi-tenant policy config layer; links CME, Jarvis, existing `property_policy`. |
