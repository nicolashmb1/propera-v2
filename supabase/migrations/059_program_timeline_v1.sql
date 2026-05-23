-- Program run / line timeline V1 — append-only audit for preventive (portal Activity).
-- Writers: V2 DAL (programTimeline.js); not DB triggers on program_runs/lines.
-- See docs/PM_PROGRAM_ENGINE_V1.md

create table if not exists public.program_timeline_events (
  id uuid primary key default gen_random_uuid(),
  program_run_id uuid not null references public.program_runs (id) on delete cascade,
  program_line_id uuid references public.program_lines (id) on delete set null,
  occurred_at timestamptz not null default now(),
  event_kind text not null,
  headline text not null,
  detail text not null default '',
  actor_label text not null default ''
);

create index if not exists program_timeline_events_run_occurred_idx
  on public.program_timeline_events (program_run_id, occurred_at);

comment on table public.program_timeline_events is
  'Preventive program Activity V1 — explicit DAL writers; distinct event_kind per action';

alter table public.program_timeline_events enable row level security;
