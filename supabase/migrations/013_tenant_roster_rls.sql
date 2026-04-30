-- Lock down tenant_roster for Supabase API: anon/authenticated must not read/write PII by default.
-- Server-side `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS (used by propera-v2 DAL).
-- Add explicit SELECT/INSERT policies later only if you expose this table to clients.

alter table public.tenant_roster enable row level security;

-- No policies for `anon` / `authenticated` => default deny via PostgREST.
-- Service role: full access (bypasses RLS).

comment on table public.tenant_roster is
  'GAS Tenants sheet — staff #capture lookup. RLS on; API clients use service role or add policies.';
