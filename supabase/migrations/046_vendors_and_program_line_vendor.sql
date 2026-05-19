-- Vendors catalog + optional vendor on preventive program lines.
-- PM portal assigns tickets via existing assignment columns (assigned_type = VENDOR).
-- See docs/PM_ASSIGNMENT_OVERRIDE.md Phase 5.

-- ---------------------------------------------------------------------------
-- vendors — org-wide vendor directory for PM assignment
-- ---------------------------------------------------------------------------
create table if not exists public.vendors (
  vendor_id text primary key,
  display_name text not null default '',
  active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_active_idx on public.vendors (active) where active = true;

comment on table public.vendors is 'PM-managed vendors for ticket and preventive-line assignment';
comment on column public.vendors.vendor_id is 'Stable slug (e.g. VND_PLUMB_CO) referenced by tickets.assigned_id when assigned_type = VENDOR';

alter table public.vendors enable row level security;

-- ---------------------------------------------------------------------------
-- program_lines — optional vendor responsible for a checklist line
-- ---------------------------------------------------------------------------
alter table public.program_lines
  add column if not exists assigned_vendor_id text not null default '',
  add column if not exists assigned_vendor_display text not null default '';

comment on column public.program_lines.assigned_vendor_id is 'vendors.vendor_id when PM assigned a vendor to this line; empty = none';
comment on column public.program_lines.assigned_vendor_display is 'Denormalized display label at assign time';
