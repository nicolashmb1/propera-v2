-- Compare LH snapshot vs Propera ledger mimic for one pilot unit (WESTFIELD 101).
-- Run after migration 108 + first import with ledger signals.

-- 1) Snapshot balance + posted line count (LH display truth)
select
  u.label as unit_label,
  s.balance_cents as snapshot_balance_cents,
  jsonb_array_length(coalesce(s.payload_json -> 'posted_transactions', '[]'::jsonb)) as snapshot_posted_count,
  s.synced_at
from public.tenant_account_snapshots s
join public.units u on u.id = s.unit_catalog_id
where upper(trim(s.property_code)) = 'WESTFIELD'
  and trim(u.label) = '101'
  and s.source_system = 'leasehold';

-- 2) Mimicked ledger lines for unit 101
select
  u.label as unit_label,
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
  and trim(u.label) = '101'
  and e.source_type = 'accounting_import'
  and e.status <> 'voided'
group by u.label;

-- 3) Line-by-line spot check (latest 10 mimicked rows)
select
  e.effective_date,
  e.entry_kind,
  e.amount_cents,
  e.description,
  e.import_idempotency_key,
  e.created_at
from public.tenant_ledger_entries e
join public.units u on u.id = e.unit_catalog_id
where upper(trim(e.property_code)) = 'WESTFIELD'
  and trim(u.label) = '101'
  and e.source_type = 'accounting_import'
order by e.effective_date desc, e.created_at desc
limit 10;
