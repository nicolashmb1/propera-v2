-- Compare LH snapshot vs Propera ledger mimic for all WESTFIELD units.
-- Run after migration 108 + import with ledger signals (building-wide pilot).

with snapshot as (
  select
    trim(u.label) as unit_label,
    s.balance_cents as snapshot_balance_cents,
    jsonb_array_length(coalesce(s.payload_json -> 'posted_transactions', '[]'::jsonb)) as snapshot_posted_count,
    s.synced_at
  from public.tenant_account_snapshots s
  join public.units u on u.id = s.unit_catalog_id
  where upper(trim(s.property_code)) = 'WESTFIELD'
    and s.source_system = 'leasehold'
),
ledger as (
  select
    trim(u.label) as unit_label,
    count(*) as ledger_import_count,
    sum(
      case
        when e.entry_kind in ('charge', 'fee') then e.amount_cents
        when e.entry_kind = 'adjustment' and e.amount_cents > 0 then e.amount_cents
        else 0
      end
    ) as charges_cents,
    sum(
      case
        when e.entry_kind in ('payment', 'credit', 'waiver') then e.amount_cents
        when e.entry_kind = 'adjustment' and e.amount_cents < 0 then -e.amount_cents
        else 0
      end
    ) as payments_cents
  from public.tenant_ledger_entries e
  join public.units u on u.id = e.unit_catalog_id
  where upper(trim(e.property_code)) = 'WESTFIELD'
    and e.source_type = 'accounting_import'
    and e.status <> 'voided'
  group by trim(u.label)
)
select
  coalesce(s.unit_label, l.unit_label) as unit_label,
  s.snapshot_balance_cents,
  s.snapshot_posted_count,
  l.ledger_import_count,
  l.charges_cents,
  l.payments_cents,
  case
    when s.unit_label is null then 'missing_snapshot'
    when l.unit_label is null then 'missing_ledger'
    when coalesce(l.ledger_import_count, 0) = 0 and coalesce(s.snapshot_posted_count, 0) > 0 then 'ledger_empty'
    when coalesce(l.ledger_import_count, 0) <> coalesce(s.snapshot_posted_count, 0) then 'count_mismatch'
    else 'ok'
  end as compare_status,
  s.synced_at
from snapshot s
full outer join ledger l on l.unit_label = s.unit_label
order by coalesce(s.unit_label, l.unit_label);
