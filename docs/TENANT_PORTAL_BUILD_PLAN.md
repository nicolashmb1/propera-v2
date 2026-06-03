# Propera V2 — Tenant Portal Build Plan

**Purpose:** Design north and phased build plan for the **resident-facing portal** in `propera-app` (`/tenant/*`) backed by **`propera-v2` `/api/tenant/*`**.

**Audience:** product, engineering, next agent implementing the tenant portal.

**Status:** **Phase D live** — migration **056**, V2 `/api/tenant` auth + brand + maintenance CRUD + notices read endpoints, propera-app login + shell + dashboard + maintenance list/new/detail + notices list.

**Related:** [AGENTS.md](../AGENTS.md) · [TENANT_PORTAL_I18N.md](./TENANT_PORTAL_I18N.md) (bilingual en/es — **spec locked, not started**) · [TENANT_ROSTER_PORTAL.md](./TENANT_ROSTER_PORTAL.md) (staff roster — **not** resident portal) · [COMMUNICATION_ENGINE.md](./COMMUNICATION_ENGINE.md) · [TICKET_TIMELINE.md](./TICKET_TIMELINE.md) · [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) · [PROPERA_GUARDRAILS.md](../../propera-gas-reference/PROPERA_GUARDRAILS.md) · [PARITY_LEDGER.md](./PARITY_LEDGER.md) · [OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md)

**North compass:** Tenant portal is a **new HTTP adapter** (JWT), not a second brain. Maintenance **creates** use structured portal `create_ticket` with **`channel: tenant_portal`** / **`actor_type: TENANT`** — same `buildStructuredPortalCreateDraft` path as PM portal (not synthetic `# prop apt …` NL parse). **Never** insert `tickets` / `work_items` directly from tenant routes.

---

## Context for Cursor

Propera V2 has two repos:

- **`propera-v2`** — Node.js + Supabase backend (engine, webhooks, API)
- **`propera-app`** — Next.js PWA (staff + owner portal at `/`, tenant portal at `/tenant/*`)

The tenant portal lives inside **`propera-app`** under `/tenant/*` routes.  
It calls **`propera-v2`** API endpoints prefixed **`/api/tenant/*`** (via Next proxies in `propera-app/src/app/api/tenant/*`).  
All `/tenant/*` routes are protected — unauthenticated users redirect to `/tenant/login`.

**Branding:** The portal is **primarily branded for the property management company** (client), not Propera. Brand values (company name, property display names, attribution flag) come from the **database** — never hardcoded. **Propera** may appear only as **secondary, controlled attribution** when `organizations.show_propera_attribution = true` — never as the primary headline or product name.

---

## Repo reality vs spec (read before coding)

| Plan / casual term | V2 today | Build note |
|--------------------|----------|------------|
| `tenants` table | **`tenant_roster`** (`012`, email `014`) | JWT `tenantId` = **`tenant_roster.id`**; comm `tenant_id` = same |
| `tenants.name` | **`resident_name`** | API field `name` |
| `unit_id` on roster | Join **`units`** on `(property_code, unit_label)` | JWT carries **`units.id`** |
| Maintenance list | **`tickets`** / **`portal_tickets_v1`** | Scope: phone + property + unit (see `028_portal_tickets_tenant_unit_scope.sql`) |
| `work_items.source` | Use **`tickets.intake_channel`** | Values include `tenant_portal`; WI is brain-internal |
| `leases` table | **`unit_leases`** (`049`) | Per **`units.id`**, not per roster row |
| Staff `/api/tenants` | Owner roster CRUD | **Not** resident `/api/tenant/*` |
| Next route guard | **`src/proxy.ts`** today | Extend for `/tenant/*` + org resolution; see **§7** |
| Org from hostname | **Not implemented** | `organizations.propera_subdomain` + `custom_domain` (**056**) |

---

## Architecture overview

```text
Tenant phone browser
  → Host: thegrand.usepropera.com  (V1) or portal.client.com (future)
  → propera-app  /tenant/*           (Next.js — UI; middleware resolves org from host)
  → propera-app  /api/tenant/*       (proxies — cookie + forward Host / x-propera-org-id)
  → propera-v2   /api/tenant/*       (Node.js — auth, data, business logic)
  → Supabase     tenant_roster, units, properties, tickets, documents, comms
  → Twilio       OTP delivery via SMS (TWILIO_SMS_FROM)
```

### Deployment strategy (domain)

**Test with A — build for B.**

| Phase | URL | Notes |
|-------|-----|--------|
| **V1 launch** | `thegrand.usepropera.com` | Propera subdomain; you control DNS |
| **Future** | `portal.thegrand.com` | Client custom domain — one CNAME + Vercel domain; **no code change** |

`resolveOrgFromHost()` handles both paths. Populating `organizations.custom_domain` + client DNS is the entire A → B migration.

### Auth + org flow

```text
Request hits /tenant/*
  → middleware: resolveOrgFromHost(host) → x-propera-org-id (or unknown-org page)
  → /tenant/login loads GET /api/tenant/brand?host=... (pre-auth branding)
  → tenant enters phone → POST /api/tenant/auth/request-otp (scoped to org)
  → OTP SMS → verify-otp → JWT cookie
  → authenticated pages: GET /api/tenant/me (+ maintenance, notices, …)
```

---

## 1. Database schema

**File:** `supabase/migrations/056_tenant_portal.sql` (after **055**).

### New tables

```sql
-- OTP codes (short-lived, purged after use or expiry)
create table public.tenant_otp_codes (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text not null,
  code        text not null,              -- 6-digit string
  expires_at  timestamptz not null,       -- now() + 10 minutes
  used        boolean not null default false,
  attempts    int not null default 0,     -- max 3 before invalidation
  created_at  timestamptz not null default now()
);
create index tenant_otp_codes_phone_active_idx
  on public.tenant_otp_codes (phone_e164, used, expires_at desc);

-- Tenant documents (uploaded by staff, read-only for tenants)
create table public.tenant_documents (
  id                  uuid primary key default gen_random_uuid(),
  org_id              text not null,
  tenant_roster_id    uuid not null references public.tenant_roster (id) on delete cascade,
  unit_id             uuid not null references public.units (id) on delete restrict,
  property_code       text not null references public.properties (code) on delete restrict,
  name                text not null,
  doc_type            text not null,      -- LEASE | ADDENDUM | BUILDING_RULES | NOTICE | OTHER
  storage_path        text not null,
  storage_bucket      text not null default 'tenant-documents',
  file_size_bytes     int,
  mime_type           text,
  uploaded_by         text not null,
  visible_to_tenant   boolean not null default true,
  created_at          timestamptz not null default now()
);
create index tenant_documents_roster_idx on public.tenant_documents (tenant_roster_id);
create index tenant_documents_unit_idx on public.tenant_documents (unit_id);
```

### Existing tables used by tenant portal

| Table | Use |
|-------|-----|
| **`tenant_roster`** | Identity: `phone_e164`, `resident_name`, `email`, `active`, `property_code`, `unit_label` |
| **`units`** | `id`, `floor`, joins for lease + comm recipients |
| **`properties`** | `display_name`, `display_name_short`, `comm_sender_label`; **`org_id`** for brand |
| **`organizations`** | `brand_name`, `brand_short_name`, **`show_propera_attribution`** |
| **`tickets`** | Maintenance list/detail; **`intake_channel`** |
| **`communication_campaigns`** + **`communication_recipients`** | Building notices (**055**) |
| **`unit_leases`** | Lease page (**049**) |
| **`tenant_ledger_entries`** | Balance (finance Phase 2+) |

### Additions to existing tables

```sql
-- Roster: portal access + locale
alter table public.tenant_roster
  add column if not exists portal_enabled boolean not null default true,
  add column if not exists preferred_language text not null default 'en';

-- Tickets: intake channel (not work_items.source)
alter table public.tickets
  add column if not exists intake_channel text not null default 'sms';
-- values: sms | whatsapp | tenant_portal | staff_portal | phone

-- Notices: read tracking
alter table public.communication_recipients
  add column if not exists opened_at timestamptz;

-- Property → org for brand
alter table public.properties
  add column if not exists org_id text;

-- Org: white-label vs standard Propera attribution + domain routing
alter table public.organizations
  add column if not exists show_propera_attribution boolean not null default true,
  add column if not exists custom_domain text unique,
  add column if not exists propera_subdomain text unique;
-- custom_domain: e.g. portal.thegrand.com (null until client ready)
-- propera_subdomain: e.g. thegrand → thegrand.usepropera.com

-- Seed example (V1 launch — edit org id to match DB):
-- update public.organizations set
--   propera_subdomain = 'thegrand',
--   custom_domain = null
-- where id = 'grand';
```

---

## 2. Auth system

### `propera-v2`: `src/tenant/authService.js`

```js
/**
 * requestOtp(phoneRaw)
 *
 * 1. Normalize phone to E.164
 * 2. Look up tenant_roster by phone_e164 AND org (from Host / x-propera-org-id)
 *    - Tenant at another org on same phone → Not found (generic 404)
 *    - Not found → TenantNotFoundError (generic 404 — do NOT reveal if phone exists)
 *    - portal_enabled = false → PortalAccessDeniedError
 *    - active = false → TenantInactiveError
 * 3. Invalidate any existing unused OTP for this phone
 * 4. Generate 6-digit numeric code
 * 5. Insert tenant_otp_codes row (expires in TENANT_OTP_TTL_MINUTES)
 * 6. Resolve brand (roster → property → organizations)
 * 7. Send SMS via Twilio FROM TWILIO_SMS_FROM:
 *    buildOtpMessage(code, brandCtx) — see §6 OTP SMS copy
 * 8. Return { success: true, brandPreview? } — never return the code
 *    Optional brandPreview after successful lookup for Step 2 UI (property display name, org short name, showProperaAttribution)
 */
export async function requestOtp(phoneRaw) {}

/**
 * verifyOtp(phoneRaw, code)
 *
 * 1. Normalize phone to E.164
 * 2. Find latest unused, non-expired OTP for this phone
 *    - Not found or expired → OtpExpiredError
 * 3. Increment attempts; if >= TENANT_OTP_MAX_ATTEMPTS → mark used, OtpMaxAttemptsError
 * 4. Timing-safe compare; mismatch → OtpInvalidError
 * 5. Mark OTP used = true
 * 6. Load tenant_roster + units + property + organizations
 * 7. Sign JWT: { tenantId, unitId, propertyCode, orgId, phone }
 *    secret: TENANT_JWT_SECRET, expiresIn: TENANT_SESSION_DAYS
 * 8. Return { token, tenant: { id, name, unitLabel, propertyDisplayName } }
 */
export async function verifyOtp(phoneRaw, code) {}

/** Used by requireTenantAuth on every /api/tenant/* request (except auth). */
export async function verifyTenantToken(token) {}
```

### `propera-v2`: API routes for auth

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/api/tenant/brand` | **Public** | `?host=thegrand.usepropera.com` — login/manifest branding (§7) |
| POST | `/api/tenant/auth/request-otp` | Public | Org from `Host` / `x-propera-org-id`; roster scoped to org |
| POST | `/api/tenant/auth/verify-otp` | Public | Returns JWT + tenant summary |
| POST | `/api/tenant/auth/logout` | Cookie | App clears `tenant_token` |

```js
// GET /api/tenant/brand?host=thegrand.usepropera.com
// Returns: { orgBrandName, orgBrandShort, showProperaAttribution, propertyDisplayName? }
// 404 if host not recognized

// POST /api/tenant/auth/request-otp  Body: { phone }
// Returns: { success: true, brandPreview? }
// Errors: 404 (generic), 403, 429

// POST /api/tenant/auth/verify-otp  Body: { phone, code }
// Returns: { token, tenant: { id, name, unitLabel, propertyDisplayName } }
```

**Rate limit:** max **3** OTP requests per phone per **15** minutes.

### `propera-v2`: Tenant auth middleware

```js
// src/middleware/tenantAuth.js
// Applied to all /api/tenant/* EXCEPT /api/tenant/brand and /api/tenant/auth/request-otp | verify-otp
// Also verify JWT orgId matches org resolved from Host

export function requireTenantAuth(req, res, next) {
  const token = req.cookies?.tenant_token
    ?? req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.tenantCtx = verifyTenantToken(token)
    next()
  } catch {
    return res.status(401).json({ error: 'Session expired' })
  }
}
```

### `propera-app`: Route protection (org + auth)

Combine **`resolveOrgFromHost`** + JWT guard in **`middleware.ts`** or extend **`src/proxy.ts`**:

```ts
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (!pathname.startsWith('/tenant')) return NextResponse.next()

  const isLoginPage = pathname === '/tenant/login'
  const host = request.headers.get('host') ?? ''
  const org = await resolveOrgFromHost(host)

  if (!org) {
    return NextResponse.rewrite(new URL('/tenant/unknown-org', request.url))
  }

  const token = request.cookies.get('tenant_token')?.value
  if (!token && !isLoginPage) {
    return NextResponse.redirect(new URL('/tenant/login', request.url))
  }
  if (token && isLoginPage) {
    return NextResponse.redirect(new URL('/tenant/dashboard', request.url))
  }

  const res = NextResponse.next()
  res.headers.set('x-propera-org-id', org.id)
  return res
}

export const config = { matcher: ['/tenant/:path*'] }
```

**Public API proxies:** `/api/tenant/brand`, `/api/tenant/auth/request-otp`, `/api/tenant/auth/verify-otp`.  
All other `/api/tenant/*` forward **`Host`** + **`x-propera-org-id`** + cookie to V2.

### `propera-app`: Auth token storage

After `verify-otp` succeeds, proxy sets httpOnly cookie:

```js
res.setHeader('Set-Cookie', serialize('tenant_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 30,
  path: '/',
}))
```

---

## 3. `propera-v2` tenant API routes

All routes require **`requireTenantAuth`** except **`/api/tenant/brand`** and **`/api/tenant/auth/*`** (except logout may accept cookie).  
Identity only from **`req.tenantCtx`** — never from body/query params.

```
GET   /api/tenant/brand              -- public; ?host= (see §7)
GET   /api/tenant/me
GET   /api/tenant/maintenance
POST  /api/tenant/maintenance
GET   /api/tenant/maintenance/:ticketId
GET   /api/tenant/maintenance/upload-url
GET   /api/tenant/notices
GET   /api/tenant/notices/:id
GET   /api/tenant/documents
GET   /api/tenant/documents/:id/url
GET   /api/tenant/lease
GET   /api/tenant/balance
PATCH /api/tenant/profile
POST  /api/tenant/auth/logout
```

### Route specs

```js
// GET /api/tenant/me
{
  tenant: { id, name, email, phone },
  unit: { id, label, floor },
  property: { code, displayName, displayNameShort },  // code internal only — never show PENN etc. in UI
  org: { brandName, brandShortName, showProperaAttribution },
  contact: { mainNumberE164 }
}

// GET /api/tenant/maintenance?status=open|closed|all&limit=20&offset=0
// portal_tickets_v1 (or DAL) scoped: phone + property_code + unit_label
{
  tickets: [{
    id, ticketId, title, category, status, priority,
    createdAt, updatedAt, lastUpdate,
    intakeChannel   // tenant_portal | sms | ...
  }],
  total
}

// POST /api/tenant/maintenance
// Body: { category, description, photoUrls?: string[] }
// → POST /webhooks/portal action create_ticket (structured — not compileTurn/SMS intake)
// → tickets.intake_channel = tenant_portal
// Returns: { ticket }

// GET /api/tenant/maintenance/:ticketId
// Verify ticket in scope; return ticket + timeline (tenant-safe labels per TICKET_TIMELINE.md)
{
  ticket: { id, title, category, status, priority, description, createdAt, ... },
  timeline: [{ event, timestamp, note, actor }]
}

// GET /api/tenant/notices?limit=20&offset=0
// communication_recipients.tenant_id = tenantCtx.tenantId
{
  notices: [{ id, campaignId, title, commType, messageBody, sentAt, deliveredAt, openedAt }]
}

// GET /api/tenant/notices/:id
// Verify recipient.tenant_id; set opened_at = now() on first fetch

// GET /api/tenant/documents
// tenant_documents.tenant_roster_id = tenantCtx.tenantId AND visible_to_tenant
{ documents: [{ id, name, docType, fileSizeBytes, mimeType, createdAt }] }

// GET /api/tenant/documents/:id/url
// Verify ownership; signed URL 15 min — regenerate each request

// GET /api/tenant/lease
// unit_leases for ctx.unitId, or:
{ available: false, message: "Lease details coming soon." }

// GET /api/tenant/balance
{ available: false, message: "Balance details coming soon." }

// PATCH /api/tenant/profile
// Body: { email?, preferredLanguage? } — phone/name read-only

// POST /api/tenant/auth/logout
{ success: true }
```

---

## 4. `propera-app` route structure

```
src/app/
  tenant/
    layout.tsx
    manifest.ts                    -- dynamic PWA manifest (§6)
    login/page.tsx
    unknown-org/page.tsx           -- invalid host / org not found (§7)
    dashboard/page.tsx
    maintenance/page.tsx
    maintenance/new/page.tsx
    maintenance/[id]/page.tsx
    notices/page.tsx
    notices/[id]/page.tsx
    documents/page.tsx
    lease/page.tsx
    balance/page.tsx
    profile/page.tsx
  api/tenant/
    brand/route.ts                 -- public proxy → GET /api/tenant/brand
    auth/request-otp/route.ts
    auth/verify-otp/route.ts
    auth/logout/route.ts
    me/route.ts
    maintenance/...
    notices/...
    documents/...
    lease/route.ts
    balance/route.ts
    profile/route.ts
```

---

## 5. Page and component specs

### `tenant/layout.tsx` — Shell

- Pull brand from **`GET /api/tenant/me`** → **`TenantBrandContext`**
- Header: **`propertyDisplayName`** (e.g. "The Grand at Penn"), tenant name
- Bottom nav (mobile-first): Home / Maintenance / Notices / Documents / Profile
- Footer: Propera attribution when **`showProperaAttribution`** (see §6) — not “no Propera anywhere”
- Neutral theme V1 — no hardcoded client brand colors

### `tenant/login/page.tsx`

**On mount:** `GET /api/tenant/brand?host={window.location.host}` → render login headline + attribution **before** phone entry (see §7).

Two-step flow, single page:

**Step 1 — Phone:**  
- Submit → `POST /api/tenant/auth/request-otp` (V2 receives org from `Host` / `x-propera-org-id`)  
- 404 → "We couldn't find an account for this number. Contact your building office."  
- On success → Step 2; optional **`brandPreview`** may refine property-specific copy

**Step 2 — OTP:**  
- "We sent a 6-digit code to [phone]"  
- Auto-advance on 6 digits → `POST /api/tenant/auth/verify-otp`  
- Success → cookie + `/tenant/dashboard`  
- Resend (rate-limited)

**Login brand treatment** — see §6 (`{propertyDisplayName} Portal`, attribution subtext).

### `tenant/dashboard/page.tsx`

1. **Unit card** — property display name, unit label, floor (`/api/tenant/me`)
2. **Quick actions** — Submit maintenance → `/tenant/maintenance/new`; View notices → `/tenant/notices`
3. **Recent maintenance** — last 3 open tickets + status badge → full list
4. **Recent notices** — last 2 notices → full list  
5. Welcome: **"Welcome back, {name}"** (no property code in copy)

### `tenant/maintenance/page.tsx`

- Tabs: Open / Closed / All
- Card: category, title, status badge, dates
- **New Request** → `/tenant/maintenance/new`
- Empty: "No maintenance requests yet. Tap New Request to submit one."

**Status badge colors:** OPEN/NEW amber · IN_PROGRESS/SCHEDULED blue · COMPLETED/CLOSED green · ON_HOLD gray

### `tenant/maintenance/new/page.tsx`

1. **Category** — Plumbing, Electrical, Appliance, HVAC, Doors & Locks, Pest, Common Area, Other  
2. **Description** — textarea; up to 3 photos via `GET /api/tenant/maintenance/upload-url` → direct Supabase upload  
3. **Review** — summary; "We'll receive your request and follow up by text." → `POST /api/tenant/maintenance` → redirect to detail

### `tenant/maintenance/[id]/page.tsx`

- Header, description, photos, timeline (chronological, tenant-safe labels)
- **"Questions? Text us at {mainNumber}"** — `sms:` link

### `tenant/notices/page.tsx`

- Card: comm type badge, title/preview, date; unread if `opened_at` null
- Empty: "No building notices yet."

### `tenant/documents/page.tsx`

- Group by `doc_type`; download via fresh signed URL
- Empty: "No documents uploaded yet. Contact your building office."

### `tenant/lease/page.tsx`

- Real **`unit_leases`** data or placeholder + unit/property from `/me`

### `tenant/balance/page.tsx`

V1 — **no fake data:**

```text
Rent Balance
━━━━━━━━━━━━━━━━━━━━━━
Balance details are coming soon.
For questions about your balance, contact your building office.
[Text us at {mainNumber}]
```

### `tenant/profile/page.tsx`

- **Editable:** email, preferred language (en / es / pt)  
- **Read-only:** name, phone, unit, property  
- Save → `PATCH /api/tenant/profile`

---

## 6. Branding rules

### Brand hierarchy

1. **Primary — Client brand** (e.g. The Grand Management Group / The Grand at Penn)  
   Dominant. This is what the tenant experiences as "their" portal.

2. **Secondary — Propera attribution** (small, consistent, tasteful)  
   Shown when **`organizations.show_propera_attribution = true`**.  
   Enterprise / white-label: `false` removes attribution (pricing lever).

The tenant should feel they are using **the client's portal**. Propera is the engine; the client is the product they see.

### Brand context shape

Nothing hardcoded. Loaded from **`GET /api/tenant/me`** (and optional **`brandPreview`** on successful `request-otp`):

```ts
// TenantBrandContext
{
  orgBrandName: "The Grand Management Group",
  orgBrandShort: "The Grand",
  propertyDisplayName: "The Grand at Penn",
  propertyDisplayNameShort: "Penn",
  mainNumberE164: "+12015551234",
  showProperaAttribution: true
}
```

### Where each brand element appears

**Client brand (always, dominant):**

| Surface | Copy |
|---------|------|
| Page `<title>` / tab | `"{orgBrandShort} Portal"` or `"{propertyDisplayName}"` — product choice; prefer client short name at portfolio level |
| PWA `name` / `short_name` | `"{orgBrandShort} Portal"` / `"{orgBrandShort}"` |
| Shell header | `{propertyDisplayName}` large |
| Login headline | `"{propertyDisplayName} Portal"` |
| Dashboard | `"Welcome back, {name}"` |
| OTP SMS opening | `"Your {orgBrandShort} verification code is {code}..."` |

**Propera attribution (when `showProperaAttribution === true`):**

| Surface | Copy |
|---------|------|
| Login subtext | `"Resident access · Powered by Propera"` |
| Shell footer | `"⬡ Powered by Propera"` — small, bottom |
| OTP SMS suffix | `" Powered by Propera."` |
| PWA description | `"... · Powered by Propera"` |

**Never shown to tenants:**

- Internal property codes (`PENN`, `MORRIS`, …) in UI copy
- **Propera as primary headline** or portal product name
- Staff/ops UI elements

### `tenant/layout.tsx` shell structure

```tsx
<div className="tenant-shell">
  <header>
    <h1>{brandCtx.propertyDisplayName}</h1>
    <span className="tenant-name">{tenant.name}</span>
  </header>
  <main>{children}</main>
  <nav>{/* Home / Maintenance / Notices / Documents / Profile */}</nav>
  {brandCtx.showProperaAttribution && (
    <footer className="propera-attribution">⬡ Powered by Propera</footer>
  )}
</div>
```

### `tenant/login/page.tsx` brand treatment

```tsx
<div className="login-screen">
  <h1>{brandCtx.propertyDisplayName} Portal</h1>
  {brandCtx.showProperaAttribution && (
    <p className="attribution">Resident access · Powered by Propera</p>
  )}
  {/* phone + OTP steps */}
</div>
```

### PWA manifest (dynamic per org)

```ts
// propera-app: src/app/tenant/manifest.ts (or route handler for manifest.json)
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = await getOrgBrandForTenantSession() // from /api/tenant/me or org config

  return {
    name: `${brand.orgBrandShort} Portal`,
    short_name: brand.orgBrandShort,
    description: `Resident portal${brand.showProperaAttribution ? ' · Powered by Propera' : ''}`,
    start_url: '/tenant/dashboard',
    scope: '/tenant/',
    display: 'standalone',
    theme_color: '#ffffff',
    background_color: '#ffffff',
    icons: [
      { src: '/icons/tenant-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/tenant-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
```

Manifest resolves org via **`resolveOrgFromHost`** (same as middleware) — **no hardcoded** org names in code.

### OTP SMS copy

```js
// authService.js
function buildOtpMessage(code, brandCtx) {
  const base = `Your ${brandCtx.orgBrandShort} verification code is ${code}. Valid for 10 minutes.`
  const attribution = brandCtx.showProperaAttribution ? ' Powered by Propera.' : ''
  return base + attribution
}
// "Your The Grand verification code is 847291. Valid for 10 minutes. Powered by Propera."
```

---

## 7. Domain routing layer

### Vercel / DNS (operator)

- Configure **`*.usepropera.com`** wildcard on Vercel (SSL).
- V1: `thegrand.usepropera.com` → production deployment.
- Future: client adds **`portal.thegrand.com` CNAME → cname.vercel-dns.com`** + add domain in Vercel — **`resolveOrgFromHost`** picks it up via `custom_domain`.

### `propera-app`: `lib/resolveOrg.ts`

```ts
export async function resolveOrgFromHost(host: string) {
  const cleanHost = host.split(':')[0]

  // Local dev fallback
  if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') {
    const devSub = process.env.DEV_ORG_SUBDOMAIN ?? 'thegrand'
    return fetchOrgBySubdomain(devSub)
  }

  // 1. Custom domain: portal.thegrand.com
  let org = await fetchOrgByCustomDomain(cleanHost)
  if (org) return org

  // 2. Propera subdomain: thegrand.usepropera.com → subdomain = 'thegrand'
  const subdomain = cleanHost.split('.')[0]
  return fetchOrgBySubdomain(subdomain)
}
```

Same function for middleware, login brand, and PWA manifest. **Never** hardcode org ids or domain strings in app code.

### `propera-v2`: brand + org scoping

- **`GET /api/tenant/brand`** — resolves org from `?host=` (same logic as app, or trust forwarded `x-propera-org-id` from proxy only on internal calls).
- **`request-otp` / `verify-otp`** — roster lookup **must** match tenant’s property → `properties.org_id` to resolved org (prevents cross-org phone reuse).
- JWT payload includes **`orgId`**; middleware on V2 rejects token if `orgId` ≠ org resolved from current Host.

### Login screen brand (pre-auth)

Login has no JWT — uses **`GET /api/tenant/brand?host=...`** on load:

```tsx
// e.g. headline from orgBrandShort when portfolio-level:
<h1>{brand.orgBrandShort} Portal</h1>
// Or propertyDisplayName when org returns a default property for login
```

After auth, **`/api/tenant/me`** supplies property-specific header copy.

### Local development

```bash
# propera-app .env.local
DEV_ORG_SUBDOMAIN=thegrand
PROPERA_V2_API_URL=http://localhost:8080
```

`localhost:3000` uses **`DEV_ORG_SUBDOMAIN`** fallback in `resolveOrgFromHost`.

### Upgrading subdomain (A) → custom domain (B)

1. `update organizations set custom_domain = 'portal.client.com' where id = '...'`
2. Client DNS CNAME → Vercel
3. Add domain in Vercel dashboard (auto SSL)  
**No code deploy.** `resolveOrgFromHost` already checks `custom_domain` first.

### Domain rules for Cursor

- Call **`resolveOrgFromHost()`** on every `/tenant/*` request; pass **`x-propera-org-id`** to pages and V2 proxies.
- Login uses **`GET /api/tenant/brand`** — the only public brand endpoint besides auth.
- Never hardcode org ids, subdomains, or hostnames.
- A → B is a **data + DNS + Vercel** change only.

---

## 8. Environment variables

**`propera-v2/.env`:**

```bash
TENANT_JWT_SECRET=              # separate from PROPERA_PORTAL_TOKEN / staff secrets
TENANT_OTP_TTL_MINUTES=10
TENANT_OTP_MAX_ATTEMPTS=3
TENANT_OTP_RATE_LIMIT_PER_15MIN=3
TENANT_SESSION_DAYS=30
SUPABASE_TENANT_DOCS_BUCKET=tenant-documents
COMM_MAIN_NUMBER_DISPLAY=       # optional E.164 for "text us"; fallback TWILIO_SMS_FROM
```

**`propera-app/.env`:**

```bash
PROPERA_V2_API_URL=             # existing — V2 base for /api/tenant proxies
DEV_ORG_SUBDOMAIN=thegrand      # localhost org resolution (§7)
```

**Vercel (production):** wildcard `*.usepropera.com`; per-client `custom_domain` when enabled.

---

## 9. Supabase Storage

| Bucket | Access | Path |
|--------|--------|------|
| **`tenant-documents`** | Private; signed read 15m | `/{orgId}/{propertyCode}/{tenantRosterId}/{filename}` |
| **`maintenance-photos`** | Private; signed upload | `/{propertyCode}/{ticketId}/{filename}` |

---

## 10. Security rules

- JWT scoped to **`tenantId`** + **`orgId`** — V2 verifies JWT `orgId` matches org from Host on every request
- Roster / OTP scoped to **resolved org** (property → `properties.org_id`)
- JWT scoped to **`tenantId`** (`tenant_roster.id`) — all queries filter by ctx; never by client-supplied ids
- **Documents:** `tenant_documents.tenant_roster_id = tenantCtx.tenantId` before URL
- **Tickets:** scope phone + property + unit (same as staff portal tenant display rule)
- **Notices:** `communication_recipients.tenant_id = tenantCtx.tenantId`
- **Phone** change: staff only (`/api/portal/tenants`)
- OTP: single-use, 10m TTL, 3 attempts, 3 requests / 15m / phone
- **`portal_enabled = false`** blocks login
- Signed URLs: 15m, no server-side URL cache

---

## 11. Build order

### Phase A — Auth + domain foundation

1. Migration **056** (OTP, documents, org domain columns, alters)
2. `resolveOrgFromHost` (app) + `GET /api/tenant/brand` (V2 + app proxy)
3. Middleware: org resolution + `x-propera-org-id` + auth redirect
4. `authService.js` + org-scoped OTP + `buildOtpMessage`
5. `/api/tenant/auth/*` + `tenantAuth` middleware (JWT `orgId` check)
6. `/tenant/login` — brand on load from `/api/tenant/brand`; OTP flow
7. `/tenant/unknown-org` page
8. **Test:** `thegrand.usepropera.com` (or localhost + `DEV_ORG_SUBDOMAIN`); OTP; cookie; wrong host → 404 brand

### Phase B — Identity and shell

1. `GET /api/tenant/me` (includes `showProperaAttribution`)
2. `tenant/layout.tsx` + `TenantBrandContext` + footer attribution
3. `tenant/dashboard` (stub recents OK)
4. **Test:** Client brand dominant; Propera footer only when flag true

### Phase C — Maintenance

1. GET list/detail; POST via **`create_ticket`** + `intake_channel = tenant_portal`
2. Upload URL + photos
3. List / new / detail pages
4. **Test:** Ticket visible in staff portal

### Phase D — Notices

1. `opened_at` (in **056**)
2. Notice APIs + UI
3. **Test:** Broadcast visible to tenant

### Phase E — Documents

1. Storage bucket + staff upload path
2. Tenant list + signed download
3. **Test:** Staff upload → tenant download

### Phase F — Lease, balance, profile

1. Lease API or placeholder
2. Balance placeholder
3. Profile PATCH + pages
4. Dynamic PWA manifest via **`resolveOrgFromHost`**

### Phase G — Custom domain (ops, when client ready)

1. Set `organizations.custom_domain`
2. Client DNS + Vercel domain
3. Smoke-test — no code change

---

## Key rules for Cursor

- Read **`PROPERA_GUARDRAILS.md`** before any code change.
- **`req.tenantCtx` only** for authorization on `/api/tenant/*` (except public **`/api/tenant/brand`** and auth).
- **`resolveOrgFromHost()`** on every `/tenant/*` request; forward **`x-propera-org-id`** to V2; never hardcode domains or org ids.
- Login brand from **`GET /api/tenant/brand?host=...`**; post-auth brand from **`/api/tenant/me`**.
- **Client brand is primary**; **Propera only as secondary attribution** when `show_propera_attribution` is true — never Propera as headline or portal product name.
- **Never show internal property codes** (PENN, MORRIS, …) in tenant UI.
- **`TenantBrandContext`** in `tenant/layout.tsx` (from `/me`; login page uses `/brand` before auth).
- Maintenance **create** = **`create_ticket`** webhook; **`tickets.intake_channel = tenant_portal`**.
- Lease/balance: **honest placeholders** in V1 — no fake balances.
- Phone read-only in profile; signed doc URLs 15m, regenerate per request.
- OTP: mark **`used = true`** immediately on successful verify.
- Update **PARITY_LEDGER.md** / **HANDOFF_LOG.md** when behavior ships.

---

## Doc maintenance

| When | Update |
|------|--------|
| Phase ships | Status at top; **HANDOFF_LOG.md** |
| Schema | **056**+ · **OUTSIDE_CURSOR.md** |
| Env | **propera-v2/.env.example** |
| Semantics | **PARITY_LEDGER.md** |
| Agent index | **AGENTS.md** |

---

*Last updated: 2026-05-20 — domain routing (subdomain V1 + custom domain ready); branding tier; schema aligned to `tenant_roster` + `tickets.intake_channel`.*
