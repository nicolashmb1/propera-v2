-- Tenant roster vs Leasehold financial snapshot — comparison (read-only).
--
-- HOW TO RUN
--   1. Supabase Dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Uncomment filters at bottom if needed (property, non-match only)
--   4. Run → Download CSV to fix roster in /tenants
--
-- Requires: tenant_roster, units, tenant_account_snapshots (migration 094+).
-- No writes. No migrations. Safe on staging or prod.

with
norm_units as (
  select
    u.id as unit_catalog_id,
    upper(trim(u.property_code)) as property_code,
    trim(u.unit_label) as unit_label,
    upper(
      trim(
        regexp_replace(
          trim(u.unit_label),
          '^(apt|apartment|departmento|apartamento|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*',
          '',
          'i'
        )
      )
    ) as unit_norm
  from public.units u
),
roster_norm as (
  select
    tr.id as roster_id,
    tr.active,
    tr.updated_at,
    upper(trim(tr.property_code)) as property_code,
    upper(
      trim(
        regexp_replace(
          trim(tr.unit_label),
          '^(apt|apartment|departmento|apartamento|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*',
          '',
          'i'
        )
      )
    ) as unit_norm,
    trim(tr.unit_label) as unit_label,
    trim(tr.resident_name) as resident_name,
    trim(tr.phone_e164) as phone_e164
  from public.tenant_roster tr
),
roster_by_unit as (
  select
    property_code,
    unit_norm,
    count(*) filter (where active) as active_roster_count,
    count(*) filter (where not active) as inactive_roster_count,
    string_agg(
      case when active then resident_name || ' [' || phone_e164 || ']' end,
      ' | ' order by updated_at desc nulls last
    ) as active_roster_summary,
    string_agg(case when active then roster_id::text end, ',' order by updated_at desc nulls last)
      as active_roster_ids,
    max(case when active then resident_name end) as primary_roster_name,
    max(case when active then phone_e164 end) as primary_roster_phone
  from roster_norm
  group by 1, 2
),
snapshots as (
  select
    s.unit_catalog_id,
    nu.property_code,
    nu.unit_label,
    nu.unit_norm,
    s.synced_at,
    trim(s.tenant_name_display) as lh_tenant_name,
    nullif(trim(coalesce(s.payload_json ->> 'phones', '')), '') as lh_phone_raw,
    s.rent_cents,
    s.balance_cents,
    s.balance_status,
    s.lease_start,
    s.lease_end
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold'
),
unit_keys as (
  select property_code, unit_norm from snapshots
  union
  select property_code, unit_norm from roster_by_unit
),
joined as (
  select
    k.property_code,
    coalesce(
      sn.unit_label,
      (select nu.unit_label from norm_units nu
       where nu.property_code = k.property_code and nu.unit_norm = k.unit_norm limit 1)
    ) as unit_label,
    k.unit_norm,
    sn.unit_catalog_id,
    sn.synced_at,
    sn.lh_tenant_name,
    sn.lh_phone_raw,
    sn.rent_cents,
    sn.balance_cents,
    sn.balance_status,
    sn.lease_start,
    sn.lease_end,
    coalesce(rb.active_roster_count, 0) as active_roster_count,
    coalesce(rb.inactive_roster_count, 0) as inactive_roster_count,
    rb.active_roster_summary,
    rb.active_roster_ids,
    rb.primary_roster_name,
    rb.primary_roster_phone,
    coalesce(sn.lh_tenant_name, '') <> '' as lh_has_tenant,
    coalesce(rb.active_roster_count, 0) > 0 as roster_has_active
  from unit_keys k
  left join snapshots sn
    on sn.property_code = k.property_code and sn.unit_norm = k.unit_norm
  left join roster_by_unit rb
    on rb.property_code = k.property_code and rb.unit_norm = k.unit_norm
),
scored as (
  select
    j.*,
    upper(trim(regexp_replace(coalesce(j.primary_roster_name, ''), '\s+', ' ', 'g'))) as roster_name_norm,
    upper(trim(regexp_replace(coalesce(j.lh_tenant_name, ''), '\s+', ' ', 'g'))) as lh_name_norm,
    regexp_replace(coalesce(j.primary_roster_phone, ''), '\D', '', 'g') as roster_phone_digits,
    regexp_replace(coalesce(j.lh_phone_raw, ''), '\D', '', 'g') as lh_phone_digits
  from joined j
),
statused as (
  select
    s.*,
    case
      when roster_name_norm = lh_name_norm then true
      when roster_name_norm <> '' and lh_name_norm like '%' || roster_name_norm || '%' then true
      when lh_name_norm <> '' and roster_name_norm like '%' || lh_name_norm || '%' then true
      else false
    end as names_match,
    case
      when roster_phone_digits = '' or lh_phone_digits = '' then null
      when roster_phone_digits = lh_phone_digits then true
      when right(roster_phone_digits, 10) = right(lh_phone_digits, 10) then true
      else false
    end as phones_match,
    (
      lh_name_norm <> ''
      and array_length(string_to_array(lh_name_norm, ' '), 1) >= 4
    ) as lh_possible_co_tenant
  from scored s
),
final as (
  select
    property_code,
    unit_label,
    case
      when unit_catalog_id is null and roster_has_active then 'roster_no_snapshot'
      when lh_has_tenant and not roster_has_active then 'missing_roster'
      when not lh_has_tenant and roster_has_active then 'roster_without_lh_tenant'
      when active_roster_count > 1 then 'multiple_active_roster'
      when lh_has_tenant and roster_has_active and not names_match then 'name_drift'
      when lh_has_tenant and roster_has_active and names_match
        and coalesce(lh_phone_raw, '') <> ''
        and coalesce(primary_roster_phone, '') = ''
        then 'name_ok_phone_missing_on_roster'
      when lh_has_tenant and roster_has_active and names_match
        and coalesce(lh_phone_raw, '') <> ''
        and phones_match is false
        then 'phone_drift'
      when lh_possible_co_tenant and active_roster_count = 1 and names_match
        then 'possible_co_tenant_in_lh'
      when lh_has_tenant and roster_has_active and names_match then 'match'
      when not lh_has_tenant and not roster_has_active then 'both_vacant'
      else 'review'
    end as reconcile_status,
    lh_tenant_name,
    primary_roster_name,
    active_roster_summary,
    lh_phone_raw,
    primary_roster_phone,
    active_roster_count,
    active_roster_ids,
    unit_catalog_id,
    rent_cents,
    balance_cents,
    balance_status,
    lease_start,
    lease_end,
    synced_at
  from statused
)
select *
from final
where 1 = 1
  -- and property_code = 'WESTFIELD'
  -- and reconcile_status not in ('match', 'both_vacant')
order by
  property_code,
  case reconcile_status
    when 'missing_roster' then 1
    when 'roster_without_lh_tenant' then 2
    when 'name_drift' then 3
    when 'multiple_active_roster' then 4
    when 'phone_drift' then 5
    when 'name_ok_phone_missing_on_roster' then 6
    when 'possible_co_tenant_in_lh' then 7
    when 'roster_no_snapshot' then 8
    when 'review' then 9
    when 'match' then 10
    else 11
  end,
  unit_label;

-- ---------------------------------------------------------------------------
-- SUMMARY (run as second query — copy from "with norm_units" through "final")
-- ---------------------------------------------------------------------------
-- select reconcile_status, count(*) as units
-- from final
-- group by 1
-- order by units desc;
