-- WESTFIELD — roster rows that likely need full LH names (beyond round 1).
-- Heuristic: roster name is in LH string but LH has more name tokens (e.g. Diego vs DIEGO GARCIA).
-- Co-tenant units: flags rows where that person's roster name is only one word.
-- Paste results → approve round 2 renames.

with
norm_units as (
  select u.id as unit_catalog_id, trim(u.unit_label) as unit_label,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u
  where upper(trim(u.property_code)) = 'WESTFIELD'
),
snapshots as (
  select nu.unit_label, nu.unit_norm,
    trim(s.tenant_name_display) as lh_full_name
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold' and trim(s.tenant_name_display) <> ''
),
roster_active as (
  select
    tr.id as roster_id,
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.unit_label) as unit_label,
    trim(tr.resident_name) as roster_name,
    trim(tr.phone_e164) as phone_e164
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = 'WESTFIELD' and tr.active
),
joined as (
  select
    r.unit_label,
    s.lh_full_name,
    r.roster_name,
    r.phone_e164,
    r.roster_id,
    upper(trim(r.roster_name)) as rn,
    upper(trim(s.lh_full_name)) as ln,
    array_length(regexp_split_to_array(trim(r.roster_name), '\s+'), 1) as roster_word_count,
    array_length(regexp_split_to_array(trim(s.lh_full_name), '\s+'), 1) as lh_word_count
  from roster_active r
  join snapshots s on s.unit_norm = r.unit_norm
),
scored as (
  select
    unit_label,
    lh_full_name,
    roster_name,
    phone_e164,
    roster_id,
    roster_word_count,
    lh_word_count,
    case
      when roster_word_count = 1
        and ln like '%' || rn || '%'
        and lh_word_count > roster_word_count
        then 'expand_single_name'
      when roster_word_count >= 2
        and rn <> ln
        and not (ln like '%' || rn || '%')
        then 'review'
      else null
    end as suggest
  from joined
)
select
  unit_label,
  lh_full_name,
  roster_name,
  phone_e164,
  roster_id,
  suggest
from scored
where suggest is not null
  and unit_label not in ('201')  -- Katheline kept by choice
order by
  case suggest when 'expand_single_name' then 1 else 2 end,
  unit_label,
  roster_name;
