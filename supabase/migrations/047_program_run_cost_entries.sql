-- Program-run (preventive) cost entries share `ticket_cost_entries` with ticket-backed rows.
-- Exactly one of (ticket_id, program_run_id) must be set. Optional program_line_id scopes a line.

alter table public.ticket_cost_entries
  alter column ticket_id drop not null;

alter table public.ticket_cost_entries
  add column if not exists program_run_id uuid references public.program_runs (id) on delete cascade,
  add column if not exists program_line_id uuid references public.program_lines (id) on delete set null;

alter table public.ticket_cost_entries drop constraint if exists ticket_cost_entries_parent_chk;
alter table public.ticket_cost_entries add constraint ticket_cost_entries_parent_chk check (
  (ticket_id is not null and program_run_id is null)
  or (ticket_id is null and program_run_id is not null)
);

create index if not exists ticket_cost_entries_program_run_id_idx
  on public.ticket_cost_entries (program_run_id)
  where program_run_id is not null;

alter table public.ticket_cost_entries drop constraint if exists ticket_cost_entries_entry_type_chk;
alter table public.ticket_cost_entries add constraint ticket_cost_entries_entry_type_chk check (
  entry_type in (
    'material',
    'parts',
    'labor',
    'vendor_invoice',
    'cleaning',
    'permit',
    'other'
  )
);

comment on table public.ticket_cost_entries is
  'Operational maintenance cost + tenant charge decision; parent is either a ticket or a program run (preventive).';
