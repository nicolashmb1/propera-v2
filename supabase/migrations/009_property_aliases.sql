-- Property aliases for database-driven property detection (no hardcoded names in code).
-- Safe to run multiple times.

create table if not exists public.property_aliases (
  id bigserial primary key,
  property_code text not null references public.properties(code) on delete cascade,
  alias text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists property_aliases_property_code_alias_uq
  on public.property_aliases (property_code, lower(alias));

create index if not exists property_aliases_active_idx
  on public.property_aliases (active, property_code);

comment on table public.property_aliases is
  'Config-managed aliases per property for intake property detection parity.';
