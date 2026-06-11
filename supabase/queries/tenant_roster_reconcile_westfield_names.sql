-- WESTFIELD — name check only (LH name vs active roster names per unit).
-- Paste rows where name_status <> 'ok'.

with
norm_units as (
  select u.id as unit_catalog_id, upper(trim(u.property_code)) as property_code,
    trim(u.unit_label) as unit_label,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u
  where upper(trim(u.property_code)) = 'WESTFIELD'
),
snapshots as (
  select nu.unit_label, nu.unit_norm,
    trim(s.tenant_name_display) as lh_tenant_name
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold' and trim(s.tenant_name_display) <> ''
),
roster_active as (
  select
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.unit_label) as unit_label,
    tr.id as roster_id,
    trim(tr.resident_name) as roster_name,
    trim(tr.phone_e164) as phone_e164
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = 'WESTFIELD' and tr.active
),
by_unit as (
  select
    s.unit_label,
    s.lh_tenant_name,
    count(r.roster_id) as active_roster_count,
    string_agg(r.roster_name || ' (' || r.phone_e164 || ')', ' | ' order by r.roster_name) as roster_names,
    bool_or(
      upper(trim(r.roster_name)) = upper(trim(s.lh_tenant_name))
      or upper(trim(s.lh_tenant_name)) like '%' || upper(trim(r.roster_name)) || '%'
      or upper(trim(r.roster_name)) like '%' || upper(trim(s.lh_tenant_name)) || '%'
    ) as any_name_matches_lh
  from snapshots s
  left join roster_active r on r.unit_norm = s.unit_norm
  group by s.unit_label, s.lh_tenant_name
),
scored as (
  select
    unit_label,
    lh_tenant_name,
    coalesce(roster_names, '(no active roster)') as roster_names,
    active_roster_count,
    case
      when active_roster_count = 0 then 'missing_roster'
      when not coalesce(any_name_matches_lh, false) then 'name_drift'
      when active_roster_count > 1 then 'co_tenant_check'
      else 'ok'
    end as name_status
  from by_unit
)
select unit_label, lh_tenant_name, roster_names, active_roster_count, name_status
from scored
where name_status <> 'ok'
order by
  case name_status
    when 'missing_roster' then 1
    when 'name_drift' then 2
    else 3
  end,
  unit_label;
