-- UTC calendar year-to-date maintenance spend on portal_properties_v1 (sums monthly rollup from Jan 1 UTC).

create or replace view public.portal_properties_v1 as
select
  trim(p.code) as property_code,
  trim(coalesce(p.display_name, p.code)) as name,
  trim(coalesce(p.short_name, '')) as short_name,
  trim(coalesce(p.ticket_prefix, '')) as ticket_prefix,
  coalesce(r.open_count, 0)::integer as open,
  coalesce(r.urgent_count, 0)::integer as urgent,
  coalesce(uc.unit_count, 0)::integer as units,
  coalesce(uc.occupied_count, 0)::integer as occupied,
  '—'::text as avg_resolution,
  '—'::text as last_activity,
  trim(coalesce(p.address, '')) as address,
  p.program_expansion_profile,
  coalesce(fin.total_cost_cents, 0)::bigint as maintenance_spend_cents_month,
  coalesce(fin.total_tenant_charge_cents, 0)::bigint as maintenance_tenant_charge_cents_month,
  coalesce(fin.entry_count, 0)::bigint as maintenance_cost_entry_count_month,
  coalesce(spend_ytd.total_cost_cents, 0)::bigint as maintenance_spend_cents_ytd,
  coalesce(spend_ytd.total_tenant_charge_cents, 0)::bigint as maintenance_tenant_charge_cents_ytd,
  coalesce(spend_ytd.entry_count, 0)::bigint as maintenance_cost_entry_count_ytd
from public.properties p
left join public.portal_property_rollups_v1 r
  on upper(trim(r.property_code)) = upper(trim(p.code))
left join lateral (
  select
    count(*)::integer as unit_count,
    count(*) filter (
      where lower(trim(u.status)) = 'occupied'
    )::integer as occupied_count
  from public.units u
  where upper(trim(u.property_code)) = upper(trim(p.code))
) uc on true
left join public.portal_property_maintenance_spend_month_v1 fin
  on upper(trim(fin.property_code)) = upper(trim(p.code))
  and fin.month_utc = (date_trunc('month', (current_timestamp at time zone 'UTC')))::date
left join lateral (
  select
    coalesce(sum(m.total_cost_cents), 0)::bigint as total_cost_cents,
    coalesce(sum(m.total_tenant_charge_cents), 0)::bigint as total_tenant_charge_cents,
    coalesce(sum(m.entry_count), 0)::bigint as entry_count
  from public.portal_property_maintenance_spend_month_v1 m
  where upper(trim(m.property_code)) = upper(trim(p.code))
    and m.month_utc >= (date_trunc('year', (current_timestamp at time zone 'UTC')))::date
) spend_ytd on true
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_properties_v1 is
  'Active properties with ticket KPIs, units catalog counts, UTC-month and UTC-YTD maintenance spend.';
