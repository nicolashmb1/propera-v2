-- Speed unit hub tenant ledger reads (property + unit catalog).
create index if not exists tenant_ledger_prop_unit_created_idx
  on public.tenant_ledger_entries (upper(trim(property_code)), unit_catalog_id, created_at asc);
