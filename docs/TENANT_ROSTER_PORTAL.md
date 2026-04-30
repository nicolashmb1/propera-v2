# Tenant roster (portal)

Source of truth: **`public.tenant_roster`** (migration `012`, email in `014`).

## HTTP (propera-v2)

All routes require **`X-Propera-Portal-Token`** / `?token=` / `Authorization: Bearer` matching **`PROPERA_PORTAL_TOKEN`** (`portalAuth.js`).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/portal/tenants` | Array of roster rows (display `property` joined from `properties`). |
| GET | `/api/portal/gas-compat?path=tenants` | Same payload as GAS `path=tenants` for legacy clients. |
| POST | `/api/portal/tenants` | Body: `property`, `unit`, `phone`, optional `name`, `email`, `notes`, `active`. |
| PATCH | `/api/portal/tenants/:id` | Partial update. |
| DELETE | `/api/portal/tenants/:id` | Soft delete (`active=false`). |

## propera-app

- UI: **`/tenants`** (hidden for staff mode).
- Next routes proxy to V2 using **`PROPERA_V2_API_URL`** (gas-compat base URL; origin is used for `/api/portal/tenants`) and **`PROPERA_PORTAL_TOKEN`**.
- Mutations require a non-staff session when **`PROPERA_AUTH_REQUIRED`** is on; staff role from GAS `path=me` is blocked (`tenantMutationGuard.ts`).
