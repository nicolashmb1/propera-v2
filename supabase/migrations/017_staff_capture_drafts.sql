-- GAS-style staff #capture: one row per draft D### (monotonic seq), not one intake_sessions row per staff phone.
-- Safe re-run: IF NOT EXISTS

create sequence if not exists public.staff_capture_draft_seq;

create or replace function public.next_staff_capture_draft_seq()
returns bigint
language sql
security definer
set search_path = public
as $$ select nextval('public.staff_capture_draft_seq'); $$;

grant execute on function public.next_staff_capture_draft_seq() to authenticated, service_role;

create table if not exists public.staff_capture_drafts (
  id uuid primary key default gen_random_uuid(),
  draft_seq bigint not null unique,
  staff_phone_e164 text not null,
  stage text default '',
  expected text default '',
  draft_property text default '',
  draft_unit text default '',
  draft_issue text default '',
  issue_buf_json jsonb default '[]'::jsonb,
  draft_schedule_raw text default '',
  active_artifact_key text default '',
  expires_at_iso text default '',
  updated_at_iso timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists staff_capture_drafts_staff_idx
  on public.staff_capture_drafts (staff_phone_e164);

create index if not exists staff_capture_drafts_staff_seq_idx
  on public.staff_capture_drafts (staff_phone_e164, draft_seq);

comment on table public.staff_capture_drafts is 'GAS SCAP:D### — per-draft intake; new # line allocates new draft_seq';
