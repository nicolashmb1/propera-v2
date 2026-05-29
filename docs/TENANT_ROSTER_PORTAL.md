# Tenant roster (portal)

**Staff roster CRUD** — not the resident tenant portal. For resident login, maintenance, notices, see **[TENANT_PORTAL_BUILD_PLAN.md](./TENANT_PORTAL_BUILD_PLAN.md)**.

Source of truth: **`public.tenant_roster`** (migration `012`, email in `014`).

## HTTP (propera-v2)

All routes require **`X-Propera-Portal-Token`** / `?token=` / `Authorization: Bearer` matching **`PROPERA_PORTAL_TOKEN`** (`portalAuth.js`).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/portal/tenants` | Active roster rows only. Append `?includeInactive=1` for full roster (Tenants/Roster admin). |
| GET | `/api/portal/gas-compat?path=tenants` | Same as above; supports `includeInactive=1`. |
| POST | `/api/portal/tenants` | Body: `property`, `unit`, `phone`, optional `name`, `email`, `notes`, `active`. |
| PATCH | `/api/portal/tenants/:id` | Partial update. |
| DELETE | `/api/portal/tenants/:id` | Soft delete (`active=false`). |

## propera-app

- UI: **`/tenants`** (hidden for staff mode). Loads full roster via `GET /api/tenants?includeInactive=1`; all other portal pickers use active-only list.
- Next routes proxy to V2 using **`PROPERA_V2_API_URL`** (gas-compat base URL; origin is used for `/api/portal/tenants`) and **`PROPERA_PORTAL_TOKEN`**.
- Mutations require a non-staff session when **`PROPERA_AUTH_REQUIRED`** is on; staff role from GAS `path=me` is blocked (`tenantMutationGuard.ts`).
