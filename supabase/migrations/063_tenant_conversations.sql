-- Tenant Agent adapter: conversation state (gathering / handoff); not intake_sessions slots.

create table if not exists public.tenant_conversations (
  id uuid primary key default gen_random_uuid(),

  tenant_actor_key text not null,
  transport_channel text not null default 'sms',

  status text not null default 'gathering',

  partial_package jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  last_brain_result jsonb,

  tenant_locale text not null default 'en',
  tenant_locale_confidence numeric(4, 3),

  turn_count int not null default 0,
  max_turns int not null default 12,

  handoff_trace_id text,
  handoff_at timestamptz,

  active_ticket_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_actor_key, transport_channel)
);

create index if not exists tenant_conversations_status_idx
  on public.tenant_conversations (status, updated_at desc);

comment on table public.tenant_conversations is
  'Tenant Agent adapter: conversation history + partial package; not brain session slots (intake_sessions).';
