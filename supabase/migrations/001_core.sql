-- Propera V2 — core tables (draft; mirrors GAS sheet meanings — see docs/SHEETS_TO_POSTGRES.md)
-- Apply in Supabase: SQL Editor → paste → Run (or supabase db push when CLI is linked)

-- Extensions (Supabase usually has these; safe if already present)
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- conversation_ctx  (was: ConversationContext sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_ctx (
  phone_e164 text primary key,
  lang text default 'en',
  active_work_item_id text default '',
  pending_work_item_id text default '',
  pending_expected text default '',
  pending_expires_at timestamptz,
  last_intent text default '',
  updated_at timestamptz default now(),
  preferred_channel text default '',
  telegram_chat_id text default '',
  last_actor_key text default '',
  last_inbound_at timestamptz
);

-- ---------------------------------------------------------------------------
-- work_items  (was: WorkItems sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.work_items (
  id uuid primary key default gen_random_uuid(),
  work_item_id text not null unique,
  type text not null default 'MAINT',
  status text not null default 'OPEN',
  state text not null default 'INTAKE',
  substate text default '',
  phone_e164 text default '',
  property_id text default '',
  unit_id text default '',
  ticket_row integer,
  metadata_json jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  owner_type text default '',
  owner_id text default '',
  assigned_by_policy text default '',
  assigned_at timestamptz,
  ticket_key text default ''
);

create index if not exists work_items_phone_idx on public.work_items (phone_e164);
create index if not exists work_items_ticket_key_idx on public.work_items (ticket_key);

-- ---------------------------------------------------------------------------
-- tickets  (was: Sheet1 / COL)
-- ---------------------------------------------------------------------------
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_id text unique,
  tenant_phone_e164 text default '',
  property_code text default '',
  unit_label text default '',
  message_raw text default '',
  category text default '',
  status text default '',
  ticket_key text default '',
  sheet_row_legacy integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists tickets_ticket_id_idx on public.tickets (ticket_id);
create index if not exists tickets_phone_idx on public.tickets (tenant_phone_e164);

-- ---------------------------------------------------------------------------
-- directory  (was: Directory sheet / DIR_COL)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_directory (
  phone_e164 text primary key,
  property_code text default '',
  property_name text default '',
  last_updated timestamptz default now(),
  pending_issue text default '',
  pending_unit text default '',
  pending_row integer,
  pending_stage text default '',
  handoff_sent text default '',
  welcome_sent text default '',
  active_ticket_key text default '',
  issue_buf_json jsonb,
  draft_schedule_raw text default '',
  canonical_unit text default ''
);

-- ---------------------------------------------------------------------------
-- property_policy  (was: PropertyPolicy sheet; ppGet_)
-- ---------------------------------------------------------------------------
create table if not exists public.property_policy (
  id uuid primary key default gen_random_uuid(),
  property_code text not null,
  policy_key text not null,
  value text default '',
  value_type text default '',
  unique (property_code, policy_key)
);

create index if not exists property_policy_prop_idx on public.property_policy (property_code);

-- ---------------------------------------------------------------------------
-- templates  (was: Templates sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  lang text not null default 'en',
  body text not null default '',
  unique (template_key, lang)
);

-- ---------------------------------------------------------------------------
-- intake_sessions  (was: Sessions sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.intake_sessions (
  phone_e164 text primary key,
  stage text default '',
  expected text default '',
  lane text default '',
  draft_property text default '',
  draft_unit text default '',
  draft_issue text default '',
  issue_buf_json jsonb,
  draft_schedule_raw text default '',
  active_artifact_key text default '',
  expires_at_iso text default '',
  updated_at_iso timestamptz default now()
);

comment on table public.conversation_ctx is 'GAS: ConversationContext';
comment on table public.work_items is 'GAS: WorkItems';
comment on table public.tickets is 'GAS: Sheet1 ticket log';
comment on table public.tenant_directory is 'GAS: Directory';
comment on table public.property_policy is 'GAS: PropertyPolicy';
comment on table public.message_templates is 'GAS: Templates';
comment on table public.intake_sessions is 'GAS: Sessions';
