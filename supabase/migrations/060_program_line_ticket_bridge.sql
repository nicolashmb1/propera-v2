-- Preventive program line ↔ maintenance ticket bridge (P2).
-- Pattern mirrors turnover_items / tickets turnover linkage (039).

alter table public.program_lines
  add column if not exists linked_ticket_id text not null default '',
  add column if not exists linked_work_item_id text not null default '';

comment on column public.program_lines.linked_ticket_id is
  'Human ticket id (e.g. PENN-MMDDYY-####) when issue escalated to reactive maintenance';
comment on column public.program_lines.linked_work_item_id is
  'Work item id (WI_…) when linked to a ticket';

alter table public.tickets
  add column if not exists program_run_id uuid null references public.program_runs (id) on delete set null,
  add column if not exists program_line_id uuid null references public.program_lines (id) on delete set null;

create index if not exists tickets_program_run_id_idx
  on public.tickets (program_run_id)
  where program_run_id is not null;

create index if not exists tickets_program_line_id_idx
  on public.tickets (program_line_id)
  where program_line_id is not null;

alter table public.work_items
  add column if not exists program_run_id uuid null references public.program_runs (id) on delete set null;

create index if not exists work_items_program_run_id_idx
  on public.work_items (program_run_id)
  where program_run_id is not null;

comment on column public.tickets.program_run_id is 'Optional parent preventive program run';
comment on column public.tickets.program_line_id is 'Optional checklist line that spawned this ticket';
