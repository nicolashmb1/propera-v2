-- Preventive / Tasks V1 — template-driven program runs + checklist lines.
-- See docs/PM_PROGRAM_ENGINE_V1.md. Server uses service role (bypasses RLS).

-- ---------------------------------------------------------------------------
-- program_templates — expansion behavior + optional default scopes (floors, etc.)
-- ---------------------------------------------------------------------------
create table if not exists public.program_templates (
  template_key text primary key,
  label text not null,
  expansion_type text not null,
  default_scope_labels jsonb default null,
  constraint program_templates_expansion_type_chk check (
    expansion_type in (
      'UNIT_PLUS_COMMON',
      'FLOOR_BASED',
      'COMMON_AREA_ONLY',
      'CUSTOM_MANUAL'
    )
  )
);

comment on table public.program_templates is 'PM/Task V1 — defines checklist expansion (see PM_PROGRAM_ENGINE_V1.md)';
comment on column public.program_templates.default_scope_labels is
  'JSON array of strings for FLOOR_BASED / COMMON_AREA_ONLY when property has no metadata';

insert into public.program_templates (template_key, label, expansion_type, default_scope_labels)
values
  ('HVAC_PM', 'HVAC Maintenance', 'UNIT_PLUS_COMMON', null),
  ('WATER_HEATER_PM', 'Water Heater Maintenance', 'UNIT_PLUS_COMMON', null),
  (
    'COMMON_AREA_PAINT',
    'Common Area Painting',
    'FLOOR_BASED',
    '["1st Floor", "2nd Floor", "3rd Floor", "Stairwell"]'::jsonb
  )
on conflict (template_key) do nothing;

-- ---------------------------------------------------------------------------
-- program_runs — one operational program instance per property + template
-- ---------------------------------------------------------------------------
create table if not exists public.program_runs (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  template_key text not null references public.program_templates (template_key),
  title text not null,
  status text not null default 'OPEN',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint program_runs_status_chk check (
    status in ('OPEN', 'IN_PROGRESS', 'COMPLETE')
  )
);

create index if not exists program_runs_property_idx on public.program_runs (property_code);
create index if not exists program_runs_created_idx on public.program_runs (created_at desc);

comment on table public.program_runs is 'PM/Task V1 — parent program (building operation checklist)';

-- ---------------------------------------------------------------------------
-- program_lines — checklist rows (units, floors, common area, etc.)
-- ---------------------------------------------------------------------------
create table if not exists public.program_lines (
  id uuid primary key default gen_random_uuid(),
  program_run_id uuid not null references public.program_runs (id) on delete cascade,
  scope_type text not null,
  scope_label text not null,
  sort_order integer not null default 0,
  status text not null default 'OPEN',
  completed_by text not null default '',
  completed_at timestamptz,
  notes text not null default '',
  constraint program_lines_scope_type_chk check (
    scope_type in ('UNIT', 'COMMON_AREA', 'FLOOR', 'SITE')
  ),
  constraint program_lines_status_chk check (status in ('OPEN', 'COMPLETE'))
);

create index if not exists program_lines_run_idx on public.program_lines (program_run_id);

comment on table public.program_lines is 'PM/Task V1 — line items staff complete';

-- RLS: default deny for anon/authenticated; Node uses service role.
alter table public.program_templates enable row level security;
alter table public.program_runs enable row level security;
alter table public.program_lines enable row level security;
