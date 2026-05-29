-- Access Engine follow-up: access-owned lifecycle queue for approval timeouts,
-- reminders, activation, and completion beside maintenance lifecycle timers.

create table if not exists public.access_lifecycle_jobs (
  id            uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.access_reservations (id) on delete cascade,
  job_type      text not null
    check (job_type in ('APPROVAL_TIMEOUT', 'REMINDER', 'START_WINDOW', 'END_WINDOW')),
  status        text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'COMPLETED', 'CANCELLED')),
  run_at        timestamptz not null,
  payload_json  jsonb not null default '{}'::jsonb,
  claimed_at    timestamptz,
  claimed_by    text not null default '',
  completed_at  timestamptz,
  cancelled_at  timestamptz,
  last_error    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (reservation_id, job_type)
);

create index if not exists access_lifecycle_jobs_status_run_idx
  on public.access_lifecycle_jobs (status, run_at);

comment on table public.access_lifecycle_jobs is
  'Access-owned lifecycle queue for reservation approvals, reminders, activation, and completion.';
