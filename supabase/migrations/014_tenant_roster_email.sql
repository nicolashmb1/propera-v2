-- Portal tenant editor: optional email per roster row (GAS Tenants sheet parity).

alter table public.tenant_roster
  add column if not exists email text not null default '';

create index if not exists tenant_roster_phone_idx on public.tenant_roster (phone_e164);

comment on column public.tenant_roster.email is 'Optional resident email for portal display; not required for staff #capture lookup';
