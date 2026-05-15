-- Add per-week average resolution (days) for tickets resolved in that calendar week.
-- Matches portal_resolution_stats_v1 day math: created_at → closed_at, non-deleted, closed_at >= created_at.

create or replace view public.portal_analytics_resolved_weekly_v1 as
select
  date_trunc('week', closed_at)::date as week_start,
  count(*)::bigint as resolved_count,
  round(
    avg(
      case
        when created_at is not null
          and closed_at is not null
          and closed_at >= created_at
        then greatest(0, extract(epoch from (closed_at - created_at)) / 86400.0)
        else null
      end
    )::numeric,
    1
  ) as avg_resolution_days
from public.tickets
where closed_at is not null
  and lower(trim(coalesce(status, ''))) <> 'deleted'
group by 1
order by 1 desc;

comment on view public.portal_analytics_resolved_weekly_v1 is
  'Tickets resolved per calendar week (closed_at) + avg resolution days for those tickets';
