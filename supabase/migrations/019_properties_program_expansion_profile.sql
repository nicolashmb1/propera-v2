-- Per-property hints for PM/Task line expansion (templates stay generic).
-- See docs/PM_PROGRAM_ENGINE_V1.md — keys e.g. floor_paint_scopes, common_paint_scopes.

alter table public.properties
  add column if not exists program_expansion_profile jsonb not null default '{}'::jsonb;

comment on column public.properties.program_expansion_profile is
  'JSON: PM expansion hints (floor_paint_scopes[], common_paint_scopes[], …) — see PM_PROGRAM_ENGINE_V1.md';
