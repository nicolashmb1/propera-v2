-- Durable policy timers (GAS `lifecycleWriteTimer_` / `lifecycleCancelTimersForWi_`).
-- Claimed by POST `/internal/cron/lifecycle-timers` with `LIFECYCLE_CRON_SECRET`.

create table if not exists public.lifecycle_timers (
  id uuid primary key default gen_random_uuid(),
  work_item_id text not null,
  property_code text not null default '',
  timer_type text not null,
  run_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  trace_id text,
  status text not null default 'pending'
    check (status in ('pending', 'fired', 'cancelled')),
  created_at timestamptz not null default now(),
  fired_at timestamptz
);

create index if not exists lifecycle_timers_due_idx
  on public.lifecycle_timers (run_at)
  where status = 'pending';

create index if not exists lifecycle_timers_wi_status_idx
  on public.lifecycle_timers (work_item_id, status);

comment on table public.lifecycle_timers is
  'Lifecycle engine timers; service role only until explicit policies.';

alter table public.lifecycle_timers enable row level security;
