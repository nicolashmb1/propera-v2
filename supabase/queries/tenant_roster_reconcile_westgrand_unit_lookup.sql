-- WESTGRAND — LH (finance) full names for specific units.
-- Paste roster names vs lh_tenant_name side by side.

with
norm_units as (
  select u.id as unit_catalog_id, trim(u.unit_label) as unit_label,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u
  where upper(trim(u.property_code)) = 'WESTGRAND'
),
snapshots as (
  select nu.unit_label,
    trim(s.tenant_name_display) as lh_full_name,
    nullif(trim(s.payload_json ->> 'phones'), '') as lh_phones,
    s.lease_start,
    s.lease_end,
    s.rent_cents,
    s.balance_cents,
    s.synced_at
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold'
),
roster as (
  select
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.unit_label) as unit_label,
    string_agg(
      trim(tr.resident_name) || ' · ' || trim(tr.phone_e164),
      E'\n' order by tr.resident_name
    ) filter (where tr.active) as active_roster
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = 'WESTGRAND' and tr.active
  group by 1, 2
)
select
  coalesce(s.unit_label, r.unit_label) as unit_label,
  s.lh_full_name,
  s.lh_phones,
  r.active_roster,
  s.lease_start,
  s.lease_end,
  round(s.rent_cents / 100.0, 2) as rent_dollars,
  round(s.balance_cents / 100.0, 2) as balance_dollars,
  s.synced_at
from snapshots s
full outer join roster r on r.unit_label = s.unit_label
where coalesce(s.unit_label, r.unit_label) in (
  '305', '306', '307', '401', '402', '403', '404', '405', '406', '407'
)
order by coalesce(s.unit_label, r.unit_label)::text;
