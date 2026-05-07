-- Read-model views for propera-app (service-role server queries). V2 owns the contract.

-- ---------------------------------------------------------------------------
-- Property open/urgent rollups (no full-table scan in Node)
-- ---------------------------------------------------------------------------
create or replace view public.portal_property_rollups_v1 as
with norm as (
  select
    upper(trim(property_code)) as property_code_u,
    lower(trim(coalesce(status, ''))) as st,
    lower(trim(coalesce(priority, ''))) as pr
  from public.tickets
  where trim(coalesce(property_code, '')) <> ''
    and lower(trim(coalesce(status, ''))) <> 'deleted'
)
select
  property_code_u as property_code,
  count(*) filter (
    where st not in (
      'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
    )
  )::bigint as open_count,
  count(*) filter (
    where pr in ('urgent', 'high')
      and st not in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
      )
  )::bigint as urgent_count
from norm
group by property_code_u;

comment on view public.portal_property_rollups_v1 is 'Per-property open and urgent ticket counts for portal UI';

-- ---------------------------------------------------------------------------
-- Properties deck — matches portal gas-compat shape closely
-- ---------------------------------------------------------------------------
create or replace view public.portal_properties_v1 as
select
  trim(p.code) as property_code,
  trim(coalesce(p.display_name, p.code)) as name,
  trim(coalesce(p.short_name, '')) as short_name,
  trim(coalesce(p.ticket_prefix, '')) as ticket_prefix,
  coalesce(r.open_count, 0)::integer as open,
  coalesce(r.urgent_count, 0)::integer as urgent,
  0::integer as units,
  0::integer as occupied,
  '—'::text as avg_resolution,
  '—'::text as last_activity,
  trim(coalesce(p.address, '')) as address,
  p.program_expansion_profile
from public.properties p
left join public.portal_property_rollups_v1 r
  on upper(trim(r.property_code)) = upper(trim(p.code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_properties_v1 is 'Active properties with ticket KPIs for propera-app';

-- ---------------------------------------------------------------------------
-- Tickets list — tenant display name + import flags
-- ---------------------------------------------------------------------------
create or replace view public.portal_tickets_v1 as
select
  t.ticket_id,
  t.ticket_key,
  t.tenant_phone_e164,
  coalesce(
    (
      select tr.resident_name
      from public.tenant_roster tr
      where tr.phone_e164 = t.tenant_phone_e164
        and tr.active = true
      limit 1
    ),
    (
      select c.display_name
      from public.contacts c
      where c.phone_e164 = t.tenant_phone_e164
      limit 1
    ),
    ''
  ) as tenant_name,
  trim(coalesce(t.property_code, '')) as property_code,
  trim(coalesce(t.property_display_name, '')) as property_display_name,
  trim(coalesce(t.unit_label, '')) as unit_label,
  trim(coalesce(t.message_raw, '')) as message_raw,
  trim(coalesce(t.category, '')) as category,
  trim(coalesce(t.category_final, '')) as category_final,
  trim(coalesce(t.status, '')) as status,
  trim(coalesce(t.priority, 'normal')) as priority,
  trim(coalesce(t.service_notes, '')) as service_notes,
  t.closed_at,
  t.created_at,
  t.updated_at,
  trim(coalesce(t.preferred_window, '')) as preferred_window,
  trim(coalesce(t.assign_to, '')) as assign_to,
  trim(coalesce(t.assigned_name, '')) as assigned_name,
  trim(coalesce(t.attachments, '')) as attachments,
  coalesce(t.is_imported_history, false) as is_imported_history,
  trim(coalesce(t.source_system, '')) as source_system
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is 'Ticket rows for portal list + analytics (excludes soft-deleted)';

-- ---------------------------------------------------------------------------
-- Analytics slices (optional direct consumption by app or BI)
-- ---------------------------------------------------------------------------
create or replace view public.portal_analytics_status_v1 as
select
  trim(coalesce(status, '')) as status,
  count(*)::bigint as ticket_count
from public.tickets
where lower(trim(coalesce(status, ''))) <> 'deleted'
group by trim(coalesce(status, ''));

create or replace view public.portal_analytics_categories_v1 as
select
  case
    when trim(coalesce(category, '')) = '' then 'Uncategorized'
    else trim(category)
  end as category,
  count(*)::bigint as ticket_count
from public.tickets
where lower(trim(coalesce(status, ''))) <> 'deleted'
group by 1;

create or replace view public.portal_analytics_trend_weekly_v1 as
select
  date_trunc('week', created_at)::date as week_start,
  count(*)::bigint as opened_count
from public.tickets
where lower(trim(coalesce(status, ''))) <> 'deleted'
  and created_at is not null
group by 1
order by 1 desc;

create or replace view public.portal_analytics_resolved_weekly_v1 as
select
  date_trunc('week', closed_at)::date as week_start,
  count(*)::bigint as resolved_count
from public.tickets
where closed_at is not null
  and lower(trim(coalesce(status, ''))) <> 'deleted'
group by 1
order by 1 desc;

comment on view public.portal_analytics_status_v1 is 'Status distribution for portal analytics';
comment on view public.portal_analytics_categories_v1 is 'Category distribution for portal analytics';
comment on view public.portal_analytics_trend_weekly_v1 is 'Tickets opened per calendar week (created_at)';
comment on view public.portal_analytics_resolved_weekly_v1 is 'Tickets resolved per calendar week (closed_at)';
