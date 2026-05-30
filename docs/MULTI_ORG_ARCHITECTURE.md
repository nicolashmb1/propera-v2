# Multi-org architecture — Propera SaaS spine

**Status:** **Phase MO-4 complete (v1)** — Settings self-admin + company wizard; RLS hardening follows (MO-5).

**Goal:** A new management company can operate in Propera without operator SQL access. Multiple orgs share one V2 deployment and one Supabase project with strict data isolation at the application layer (RLS hardening follows).

---

## Model (v1)

| Concept | Storage | Notes |
|---------|---------|--------|
| **Organization** | `organizations` | Brand, subdomain, custom domain; id is stable slug (e.g. `grand`) |
| **Property** | `properties.org_id` | Operational rows scoped via property code ∈ org |
| **Portal user** | `portal_auth_allowlist.org_id` | Email unique **per org** `(org_id, email_lower)` |
| **Staff / vendors / roster** | `org_id` column | Denormalized for fast filters |
| **Tickets / work_items** | via `property_code` → `properties.org_id` | No `org_id` on tickets yet |
| **Platform secrets** | `.env` / secret manager | Twilio keys stay out of Postgres in Phase 1 |

**Resolution order (portal API):**

1. Supabase user JWT → `portal_auth_allowlist` → `org_id`
2. Else `X-Propera-Org-Id` header (server proxy, trusted)
3. Else `PROPERA_DEFAULT_ORG_ID` / `COMM_ORG_ID` (single-tenant dev fallback)

---

## Boundaries

- **propera-app** resolves org from session for reads; forwards JWT to V2 for writes.
- **propera-v2** enforces org on portal list/mutation routes; brain inbound paths unchanged in Phase 1.
- **Do not** bypass org scope on portal catalog CRUD.

---

## Phases

| Phase | Scope | Status |
|-------|--------|--------|
| **MO-1** | Migration `074`, `resolvePortalOrgContext`, scoped portal reads, `/api/me` org payload | **Done** |
| **MO-2** | Settings UI — staff, allowlist, vendors, organization profile | **Done (v1)** |
| **MO-3** | Per-org channel config metadata + guided Twilio setup | **Done (v1)** |
| **MO-2c** | Policy admin — portfolio + property overrides, audit log | **Done (v1)** |
| **MO-4** | Self-service org signup + onboarding wizard | **Done (v1)** |
| **MO-4b** (future) | Onboarding step: team coverage + default rules | After responsibility catalog Phase 1 — see [RESPONSIBILITY_ROUTING_REFACTOR.md](./RESPONSIBILITY_ROUTING_REFACTOR.md) §3.0 |
| **MO-5** | RLS policies matching app scope; cross-org integration tests | Not started |

---

## Related

- [RESPONSIBILITY_ROUTING_REFACTOR.md](./RESPONSIBILITY_ROUTING_REFACTOR.md) — team coverage, auto-assign, escalation (multi-org role catalog)
- [OPERATIONAL_POLICY_CONFIG.md](./OPERATIONAL_POLICY_CONFIG.md) — policy keys scoped portfolio → property
- [TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md) — hostname → org for residents
- [../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md](../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md)

---

## Changelog

| Date | Note |
|------|------|
| 2026-05-30 | MO-4 wizard: migration 078, `/signup/company`, org bootstrap API |
| 2026-05-30 | MO-2c policies: migration 077, `portalOrgPolicies.js`, Settings → Policies |
| 2026-05-30 | MO-3 channels: migration 076, `portalOrgChannels.js`, Settings → Channels |
| 2026-05-30 | MO-1 spine: migration 074, portal org resolution, scoped reads |
