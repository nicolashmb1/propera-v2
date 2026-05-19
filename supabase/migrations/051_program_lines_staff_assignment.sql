-- Optional staff member assigned to a preventive checklist line.
-- Mirrors the vendor pattern from migration 046.

alter table public.program_lines
  add column if not exists assigned_staff_id   text not null default '',
  add column if not exists assigned_staff_display text not null default '';

comment on column public.program_lines.assigned_staff_id      is 'portal_users.id (or staff slug) when PM assigned staff to this line; empty = none';
comment on column public.program_lines.assigned_staff_display is 'Denormalized display name at assign time';
