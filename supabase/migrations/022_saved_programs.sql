-- User-defined saved programs (property-scoped) + strict XOR on program_runs lineage.
-- See docs/PM_PROGRAM_ENGINE_V1.md

-- ---------------------------------------------------------------------------
-- saved_programs — reusable definition: display name + expansion engine + optional default scopes
-- ---------------------------------------------------------------------------
create table if not exists public.saved_programs (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  display_name text not null,
  expansion_type text not null,
  default_included_scope_labels jsonb default null,
  active boolean not null default true,
  archived_at timestamptz null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_programs_expansion_type_chk check (
    expansion_type in (
      'UNIT_PLUS_COMMON',
      'FLOOR_BASED',
      'COMMON_AREA_ONLY',
      'CUSTOM_MANUAL'
    )
  )
);

comment on table public.saved_programs is 'PM — property-scoped program definition (label + expansion type); archive via active/archived_at';

create index if not exists saved_programs_property_code_idx on public.saved_programs (property_code);

create index if not exists saved_programs_property_name_idx on public.saved_programs (property_code, display_name);

create index if not exists saved_programs_property_active_idx on public.saved_programs (property_code)
where active = true;

alter table public.saved_programs enable row level security;

-- ---------------------------------------------------------------------------
-- program_runs — allow saved-program lineage (strict XOR with legacy template_key)
-- ---------------------------------------------------------------------------
alter table public.program_runs
add column if not exists saved_program_id uuid references public.saved_programs (id) on delete restrict;

alter table public.program_runs alter column template_key drop not null;

alter table public.program_runs
add constraint program_runs_template_xor_saved_program_chk check (
  (template_key is not null and saved_program_id is null)
  or (template_key is null and saved_program_id is not null)
);

comment on column public.program_runs.saved_program_id is 'When set, run uses saved_program definition; template_key must be null (strict XOR)';
