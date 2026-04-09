-- Structured trace / event log (optional persistence; stdout JSON is primary in V2)
-- Run in Supabase SQL Editor after 001_core.sql

create table if not exists public.event_log (
  id uuid primary key default gen_random_uuid(),
  trace_id text not null,
  log_kind text not null default 'log',
  level text not null default 'info',
  event text not null default '',
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists event_log_trace_id_idx on public.event_log (trace_id);
create index if not exists event_log_created_at_idx on public.event_log (created_at desc);

comment on table public.event_log is 'Optional flight recorder; wire LOG_TO_SUPABASE in app later';
