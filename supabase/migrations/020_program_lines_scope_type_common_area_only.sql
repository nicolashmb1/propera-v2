-- COMMON_AREA_ONLY expansion uses scope_type COMMON_AREA (see expandProgramLines.js).
-- Remove legacy SITE value from check constraint; migrate any existing rows.

update public.program_lines
set scope_type = 'COMMON_AREA'
where scope_type = 'SITE';

alter table public.program_lines drop constraint if exists program_lines_scope_type_chk;

alter table public.program_lines add constraint program_lines_scope_type_chk check (
  scope_type in ('UNIT', 'COMMON_AREA', 'FLOOR')
);
