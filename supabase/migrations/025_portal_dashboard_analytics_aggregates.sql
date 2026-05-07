-- Headline KPIs and analytics slices for propera-app when reads use Supabase (no full ticket scan in Node).

-- ---------------------------------------------------------------------------
-- Dashboard headlines (single row)
-- ---------------------------------------------------------------------------
create or replace view public.portal_dashboard_headlines_v1 as
select
  (select count(*)::bigint from public.tickets t
    where lower(trim(coalesce(t.status, ''))) <> 'deleted'
  ) as total_tickets,
  (select count(*)::bigint from public.tickets t
    where lower(trim(coalesce(t.status, ''))) <> 'deleted'
      and lower(trim(coalesce(t.status, ''))) not in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
      )
  ) as open_count,
  (select count(*)::bigint from public.tickets t
    where lower(trim(coalesce(t.status, ''))) <> 'deleted'
      and lower(trim(coalesce(t.status, ''))) not in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
      )
      and lower(trim(coalesce(t.priority, ''))) in ('urgent', 'high')
  ) as urgent_open_count,
  (select count(*)::bigint from public.properties p
    where coalesce(p.active, true) = true
      and upper(trim(p.code)) <> 'GLOBAL'
  ) as property_count;

comment on view public.portal_dashboard_headlines_v1 is 'Portal dashboard headline counts — single row';

-- Oldest open ticket row (single row) — by longest time since created_at
create or replace view public.portal_dashboard_oldest_open_v1 as
select * from (
  select *
  from public.portal_tickets_v1 v
  where lower(trim(coalesce(v.status, ''))) not in (
    'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
  )
  order by v.created_at asc nulls last
  limit 1
) x;

-- Latest six open tickets for dashboard strip (highest age first → ascending created_at then reversed in app if needed)
create or replace view public.portal_dashboard_latest_open_v1 as
select * from (
  select *
  from public.portal_tickets_v1 v
  where lower(trim(coalesce(v.status, ''))) not in (
    'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
  )
  order by v.created_at asc nulls last
  limit 6
) x;

-- ---------------------------------------------------------------------------
-- Aging buckets for open tickets (matches app bucket labels)
-- ---------------------------------------------------------------------------
create or replace view public.portal_dashboard_aging_buckets_v1 as
with open_t as (
  select
    greatest(
      0,
      extract(epoch from (now() - coalesce(t.created_at, t.updated_at, now()))) / 86400.0
    )::numeric as age_days
  from public.tickets t
  where lower(trim(coalesce(t.status, ''))) <> 'deleted'
    and lower(trim(coalesce(t.status, ''))) not in (
      'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
    )
)
select * from (
  select '0–2 days'::text as label, count(*)::bigint as n, 'var(--ok)'::text as color from open_t where age_days <= 2
  union all
  select '3–7 days', count(*)::bigint, 'var(--accent)' from open_t where age_days > 2 and age_days <= 7
  union all
  select '8–14 days', count(*)::bigint, 'var(--warn)' from open_t where age_days > 7 and age_days <= 14
  union all
  select '15–30 days', count(*)::bigint, '#d9580a' from open_t where age_days > 14 and age_days <= 30
  union all
  select '30+ days', count(*)::bigint, 'var(--danger)' from open_t where age_days > 30
) b;

-- ---------------------------------------------------------------------------
-- Open ticket categories (top buckets for dashboard)
-- ---------------------------------------------------------------------------
create or replace view public.portal_dashboard_open_categories_v1 as
with open_t as (
  select
    case
      when trim(coalesce(t.category, '')) = '' then 'Uncategorized'
      else trim(t.category)
    end as cat
  from public.tickets t
  where lower(trim(coalesce(t.status, ''))) <> 'deleted'
    and lower(trim(coalesce(t.status, ''))) not in (
      'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
    )
)
select cat as name, count(*)::bigint as n
from open_t
group by cat
order by n desc;

-- ---------------------------------------------------------------------------
-- Property performance row (analytics + rollups)
-- ---------------------------------------------------------------------------
create or replace view public.portal_analytics_property_perf_v1 as
with tix as (
  select
    upper(trim(property_code)) as pc_u,
    lower(trim(coalesce(status, ''))) as st,
    lower(trim(coalesce(priority, ''))) as pr,
    created_at,
    closed_at
  from public.tickets
  where lower(trim(coalesce(status, ''))) <> 'deleted'
    and trim(coalesce(property_code, '')) <> ''
)
select
  trim(coalesce(p.display_name, p.code)) as name,
  count(t.pc_u) filter (
    where t.st is null or t.st not in (
      'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
    )
  )::bigint as open_count,
  count(t.pc_u) filter (where t.st = 'completed')::bigint as resolved_count,
  count(t.pc_u) filter (
    where t.pr in ('urgent', 'high')
      and t.st not in ('completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done')
  )::bigint as urgent_count,
  coalesce(
    avg(
      extract(epoch from (now() - t.created_at)) / 86400.0
    ) filter (
      where t.created_at is not null
        and t.st not in ('completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done')
    ),
    0
  )::numeric(14, 2) as avg_age_open_days,
  case
    when count(t.pc_u) > 0 then
      round(
        100.0 * count(t.pc_u) filter (where t.st = 'completed')::numeric
          / nullif(count(t.pc_u), 0)::numeric
      )::integer
    else 0
  end as res_rate_pct
from public.properties p
left join tix t on t.pc_u = upper(trim(p.code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL'
group by p.code, p.display_name;

comment on view public.portal_analytics_property_perf_v1 is 'Per-property ticket KPIs for analytics (no Node-side joins)';

-- ---------------------------------------------------------------------------
-- Category slice with avg age + resolved (analytics chart)
-- ---------------------------------------------------------------------------
create or replace view public.portal_analytics_category_detail_v1 as
select
  case
    when trim(coalesce(category, '')) = '' then 'Uncategorized'
    else trim(category)
  end as name,
  count(*)::bigint as tickets,
  coalesce(
    avg(
      extract(epoch from (now() - created_at)) / 86400.0
    ) filter (
      where lower(trim(coalesce(status, ''))) not in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done'
      )
      and created_at is not null
    ),
    0
  )::numeric(14, 2) as avg_age_open,
  count(*) filter (where lower(trim(coalesce(status, ''))) = 'completed')::bigint as resolved
from public.tickets
where lower(trim(coalesce(status, ''))) <> 'deleted'
group by 1;

-- ---------------------------------------------------------------------------
-- Resolution-time stats (mirrors app computeResolutionStats windows)
-- ---------------------------------------------------------------------------
create or replace view public.portal_resolution_stats_v1 as
with closed as (
  select
    greatest(
      0,
      extract(epoch from (closed_at - created_at)) / 86400.0
    )::numeric as days,
    closed_at
  from public.tickets
  where lower(trim(coalesce(status, ''))) <> 'deleted'
    and created_at is not null
    and closed_at is not null
    and closed_at >= created_at
),
agg as (
  select
    count(*)::bigint as total_n,
    avg(days)::numeric(14, 4) as avg_all_days,
    avg(days) filter (
      where closed_at >= (now() - interval '30 days')
        and closed_at <= now()
    )::numeric(14, 4) as avg_last_30,
    avg(days) filter (
      where closed_at >= (now() - interval '60 days')
        and closed_at < (now() - interval '30 days')
    )::numeric(14, 4) as avg_prev_30,
    count(*) filter (
      where closed_at >= (now() - interval '30 days')
        and closed_at <= now()
    )::bigint as n_last_30,
    count(*) filter (
      where closed_at >= (now() - interval '60 days')
        and closed_at < (now() - interval '30 days')
    )::bigint as n_prev_30
  from closed
)
select
  case when total_n = 0 then null else round(avg_all_days * 10) / 10 end as avg_resolution_days,
  case
    when coalesce(n_last_30, 0) = 0 or coalesce(n_prev_30, 0) = 0 then null
    else round(avg_last_30 * 10) / 10 - round(avg_prev_30 * 10) / 10
  end as resolution_diff_vs_prior_month_days
from agg;

comment on view public.portal_resolution_stats_v1 is 'Weighted avg resolution (days) + delta vs prior 30d window';
