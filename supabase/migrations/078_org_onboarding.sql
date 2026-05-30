-- MO-4: org onboarding wizard completion tracking.
-- @see docs/MULTI_ORG_ARCHITECTURE.md

alter table public.organizations
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists created_via text not null default 'manual';

comment on column public.organizations.onboarding_completed_at is
  'Timestamp when MO-4 company wizard finished; null means setup still in progress.';

comment on column public.organizations.created_via is
  'manual | wizard | seed — how the org row was created.';
