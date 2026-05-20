-- Manual ledger hardening: back-dated entries and per-line notes (Phase 1 finance).

alter table public.tenant_ledger_entries
  add column if not exists effective_date date,
  add column if not exists notes text not null default '';

comment on column public.tenant_ledger_entries.effective_date is 'Business date for the line; defaults to created_at::date when null';
comment on column public.tenant_ledger_entries.notes is 'Optional PM note on manual or adjusted lines';
