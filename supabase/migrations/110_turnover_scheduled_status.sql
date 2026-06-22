-- Future target-ready turnovers show as SCHEDULED (not IN_PROGRESS).

alter table public.turnovers
  drop constraint if exists turnovers_status_chk;

alter table public.turnovers
  add constraint turnovers_status_chk check (
    status in ('OPEN', 'IN_PROGRESS', 'SCHEDULED', 'READY', 'CANCELED')
  );

comment on column public.turnovers.status is
  'OPEN/IN_PROGRESS = active work; SCHEDULED = target_ready_date in the future; READY/CANCELED = terminal';
