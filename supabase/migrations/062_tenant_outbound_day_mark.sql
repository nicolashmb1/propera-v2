-- Outgate Phase 4: first tenant outbound per ops day (property header + SMS compliance footer).
-- One row per tenant actor; ops_date rolls in PROPERA_TZ (application layer).

create table if not exists public.tenant_outbound_day_mark (
  tenant_actor_key text primary key,
  ops_date text not null,
  first_outbound_at timestamptz not null default now()
);

create index if not exists tenant_outbound_day_mark_ops_date_idx
  on public.tenant_outbound_day_mark (ops_date);

comment on table public.tenant_outbound_day_mark is
  'First tenant maintenance outbound per calendar day (ops TZ) — SMS footer + property header trigger.';
