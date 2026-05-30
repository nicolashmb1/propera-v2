-- MO-2c / PC-2: audit trail for Settings policy edits (property_policy rows).
-- @see docs/OPERATIONAL_POLICY_CONFIG.md

create table if not exists public.policy_change_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  property_code text not null,
  policy_key text not null,
  old_value text,
  new_value text,
  changed_by_email text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists policy_change_log_org_created_idx
  on public.policy_change_log (org_id, created_at desc);

comment on table public.policy_change_log is
  'Append-only audit for portal Settings policy edits (who changed property_policy, when).';
