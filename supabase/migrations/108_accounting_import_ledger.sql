-- Step 2: LH ledger mimic — idempotent accounting_import lines on tenant_ledger_entries.

alter table public.tenant_ledger_entries
  drop constraint if exists tenant_ledger_entries_source_chk;

alter table public.tenant_ledger_entries
  add constraint tenant_ledger_entries_source_chk check (
    source_type in ('ticket_cost_entry', 'manual', 'stripe_checkout', 'accounting_import')
  );

alter table public.tenant_ledger_entries
  add column if not exists import_idempotency_key text;

comment on column public.tenant_ledger_entries.import_idempotency_key is
  'Stable dedupe key for accounting_import lines (e.g. leasehold:WESTFIELD:101:2026-06-03:payment:253100:seq45)';

create unique index if not exists tenant_ledger_accounting_import_key_uidx
  on public.tenant_ledger_entries (import_idempotency_key)
  where source_type = 'accounting_import' and import_idempotency_key is not null;

create index if not exists tenant_ledger_accounting_import_unit_idx
  on public.tenant_ledger_entries (upper(trim(property_code)), unit_catalog_id, effective_date asc)
  where source_type = 'accounting_import';
