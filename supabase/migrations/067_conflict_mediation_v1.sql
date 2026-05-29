-- Conflict Mediation Engine V1 — CME-1 schema (policies, cases, audit events).
-- @see docs/CONFLICT_MEDIATION_ENGINE.md

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type conflict_case_kind as enum ('VIOLATION', 'COMPLAINT', 'MIXED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type conflict_case_state as enum (
    'INTAKE',
    'POLICY_MATCH',
    'CASE_OPEN',
    'NOTICE_DRAFTED',
    'NOTICE_PENDING_APPROVAL',
    'NOTICE_SENT',
    'MONITORING',
    'SUSPENDED_PENDING_MAINTENANCE',
    'ESCALATED',
    'RESOLVED',
    'LEGAL_HOLD',
    'CLOSED'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type conflict_notice_tier as enum (
    'COURTESY',
    'SECOND',
    'FORMAL',
    'WARNING',
    'LEGAL'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type conflict_case_event_kind as enum (
    'STATE_CHANGE',
    'NOTICE',
    'COMMENT',
    'MAINTENANCE_HANDOFF',
    'POLICY_APPLIED'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- conflict_policies — structured building conduct rules
-- ---------------------------------------------------------------------------
create table if not exists public.conflict_policies (
  id                uuid primary key default gen_random_uuid(),
  org_id            text not null default '',
  property_code     text not null references public.properties (code) on delete restrict,
  policy_key        text not null default '',
  title             text not null default '',
  summary           text not null default '',
  enforceable_text  text not null default '',
  default_notice_tier conflict_notice_tier not null default 'COURTESY',
  active            boolean not null default true,
  effective_from    timestamptz not null default now(),
  effective_to      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (property_code, policy_key)
);

create index if not exists conflict_policies_property_idx
  on public.conflict_policies (property_code);

comment on table public.conflict_policies is 'CME: structured building conduct policies per property';
alter table public.conflict_policies enable row level security;

-- ---------------------------------------------------------------------------
-- conflict_cases — violation / complaint case header
-- ---------------------------------------------------------------------------
create table if not exists public.conflict_cases (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      text not null default '',
  property_code               text not null references public.properties (code) on delete restrict,
  case_kind                   conflict_case_kind not null default 'VIOLATION',
  state                       conflict_case_state not null default 'INTAKE',
  subject_unit                text not null default '',
  subject_tenant_roster_id    uuid references public.tenant_roster (id) on delete set null,
  complainant_protected       boolean not null default true,
  complainant_roster_id       uuid references public.tenant_roster (id) on delete set null,
  policy_id                   uuid references public.conflict_policies (id) on delete set null,
  maintenance_ticket_row_id   uuid references public.tickets (id) on delete set null,
  summary                     text not null default '',
  opened_by                   text not null default '',
  closed_reason               text not null default '',
  current_notice_tier         conflict_notice_tier,
  monitoring_started_at       timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists conflict_cases_property_idx
  on public.conflict_cases (property_code);

create index if not exists conflict_cases_state_idx
  on public.conflict_cases (state);

create index if not exists conflict_cases_property_state_idx
  on public.conflict_cases (property_code, state);

comment on table public.conflict_cases is 'CME: conflict / violation case lifecycle (not maintenance tickets)';
alter table public.conflict_cases enable row level security;

-- ---------------------------------------------------------------------------
-- conflict_case_events — append-only audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.conflict_case_events (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references public.conflict_cases (id) on delete cascade,
  event_kind        conflict_case_event_kind not null default 'STATE_CHANGE',
  from_state        conflict_case_state,
  to_state          conflict_case_state,
  notice_tier       conflict_notice_tier,
  policy_record_id  text not null default '',
  actor             text not null default '',
  note              text not null default '',
  payload_json      jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists conflict_case_events_case_idx
  on public.conflict_case_events (case_id, created_at desc);

comment on table public.conflict_case_events is 'CME: immutable case timeline (state, notices, policy refs)';
alter table public.conflict_case_events enable row level security;
