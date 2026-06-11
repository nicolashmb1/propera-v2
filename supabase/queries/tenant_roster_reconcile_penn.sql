-- PENN only — tenant roster vs Leasehold snapshot.
-- Run sections one at a time in Supabase SQL Editor; paste results in chat.

-- ===========================================================================
-- 1) SUMMARY COUNTS (paste this table first)
-- ===========================================================================
with
norm_units as (
  select u.id as unit_catalog_id, upper(trim(u.property_code)) as property_code,
    trim(u.unit_label) as unit_label,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u
  where upper(trim(u.property_code)) = 'PENN'
),
roster_norm as (
  select tr.id as roster_id, tr.active, tr.updated_at,
    upper(trim(tr.property_code)) as property_code,
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.resident_name) as resident_name,
    trim(tr.phone_e164) as phone_e164
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = 'PENN'
),
roster_by_unit as (
  select property_code, unit_norm,
    count(*) filter (where active) as active_roster_count,
    string_agg(case when active then resident_name || '|' || roster_id::text end, '; ' order by updated_at desc) as active_summary,
    max(case when active then resident_name end) as primary_roster_name,
    max(case when active then phone_e164 end) as primary_roster_phone
  from roster_norm group by 1, 2
),
snapshots as (
  select nu.property_code, nu.unit_norm, nu.unit_label, nu.unit_catalog_id,
    trim(s.tenant_name_display) as lh_tenant_name,
    nullif(trim(s.payload_json ->> 'phones'), '') as lh_phone_raw
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold'
),
unit_keys as (
  select property_code, unit_norm from snapshots
  union select property_code, unit_norm from roster_by_unit
),
joined as (
  select k.property_code,
    coalesce(sn.unit_label, (select nu.unit_label from norm_units nu
      where nu.property_code = k.property_code and nu.unit_norm = k.unit_norm limit 1)) as unit_label,
    sn.unit_catalog_id, sn.lh_tenant_name, sn.lh_phone_raw,
    coalesce(rb.active_roster_count, 0) as active_roster_count,
    rb.active_summary, rb.primary_roster_name, rb.primary_roster_phone,
    coalesce(sn.lh_tenant_name, '') <> '' as lh_has_tenant,
    coalesce(rb.active_roster_count, 0) > 0 as roster_has_active
  from unit_keys k
  left join snapshots sn on sn.property_code = k.property_code and sn.unit_norm = k.unit_norm
  left join roster_by_unit rb on rb.property_code = k.property_code and rb.unit_norm = k.unit_norm
),
statused as (
  select j.*,
    upper(trim(regexp_replace(coalesce(j.primary_roster_name, ''), '\s+', ' ', 'g'))) as rn,
    upper(trim(regexp_replace(coalesce(j.lh_tenant_name, ''), '\s+', ' ', 'g'))) as ln
  from joined j
),
final as (
  select property_code, unit_label, active_roster_count,
    case
      when unit_catalog_id is null and roster_has_active then 'roster_no_snapshot'
      when lh_has_tenant and not roster_has_active then 'missing_roster'
      when not lh_has_tenant and roster_has_active then 'roster_without_lh_tenant'
      when active_roster_count > 1 then 'multiple_active_roster'
      when lh_has_tenant and roster_has_active and not (
        rn = ln or (rn <> '' and ln like '%' || rn || '%') or (ln <> '' and rn like '%' || ln || '%')
      ) then 'name_drift'
      when lh_has_tenant and roster_has_active
        and (rn = ln or ln like '%' || rn || '%' or rn like '%' || ln || '%')
        and coalesce(lh_phone_raw, '') <> '' and coalesce(primary_roster_phone, '') = ''
        then 'name_ok_phone_missing'
      when lh_has_tenant and roster_has_active
        and (rn = ln or ln like '%' || rn || '%' or rn like '%' || ln || '%')
        then 'match'
      when not lh_has_tenant and not roster_has_active then 'both_vacant'
      else 'review'
    end as status,
    lh_tenant_name, primary_roster_name, lh_phone_raw, primary_roster_phone,
    active_summary, unit_catalog_id
  from statused
)
select status, count(*) as units
from final
group by 1
order by units desc;

-- ===========================================================================
-- 2) ALL ISSUES (comment section 1, uncomment below)
-- ===========================================================================
/*
with ... same CTEs as above through final ...
select property_code, unit_label, status, active_roster_count,
  lh_tenant_name, primary_roster_name, lh_phone_raw, primary_roster_phone, active_summary
from final
where status not in ('match', 'both_vacant')
order by status, unit_label;
*/

-- ===========================================================================
-- 3) MULTIPLE ACTIVE — detail with roster lines (PENN)
-- ===========================================================================
/*
with
norm_units as (
  select upper(trim(u.property_code)) as property_code, trim(u.unit_label) as unit_label,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u where upper(trim(u.property_code)) = 'PENN'
),
roster_norm as (
  select tr.id, tr.active, tr.updated_at,
    upper(trim(tr.property_code)) as property_code,
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.unit_label) as unit_label,
    trim(tr.resident_name) as resident_name,
    trim(tr.phone_e164) as phone_e164
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = 'PENN' and tr.active
),
roster_by_unit as (
  select property_code, unit_norm, count(*) as n,
    string_agg(resident_name || ' | ' || phone_e164 || ' | ' || id::text, E'\n' order by updated_at desc) as roster_lines
  from roster_norm group by 1, 2 having count(*) > 1
),
snapshots as (
  select nu.property_code, nu.unit_norm, nu.unit_label,
    trim(s.tenant_name_display) as lh_name,
    nullif(trim(s.payload_json ->> 'phones'), '') as lh_phone
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold'
)
select rb.property_code, coalesce(sn.unit_label, rb.unit_norm) as unit_label,
  rb.n as active_count, sn.lh_name, sn.lh_phone, rb.roster_lines
from roster_by_unit rb
left join snapshots sn on sn.property_code = rb.property_code and sn.unit_norm = rb.unit_norm
order by unit_label;
*/
