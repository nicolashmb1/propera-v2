-- GAS **Tenants** sheet parity — roster for staff-capture tenant phone resolution
-- (`findTenantCandidates_` / `enrichStaffCapTenantIdentity_` — `14_DIRECTORY_SESSION_DAL.gs`).
-- Columns aligned: Property → property_code, Unit → unit_label, Phone, Name, Active.

create table if not exists public.tenant_roster (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  unit_label text not null default '',
  phone_e164 text not null,
  resident_name text not null default '',
  active boolean not null default true,
  notes text default '',
  updated_at timestamptz default now()
);

create index if not exists tenant_roster_prop_idx on public.tenant_roster (property_code);
create index if not exists tenant_roster_prop_active_idx on public.tenant_roster (property_code, active);

comment on table public.tenant_roster is 'GAS Tenants sheet — staff #capture phone lookup (never use staff phone on ticket)';
