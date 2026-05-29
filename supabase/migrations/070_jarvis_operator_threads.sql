-- Jarvis operator thread state (foundation layer 2) — pending proposals + receipts per actor/channel/anchor.

create table if not exists public.jarvis_operator_threads (
  thread_id text primary key,
  actor_key text not null,
  transport_channel text not null default 'portal',
  anchor_fingerprint text not null default 'global',
  status text not null default 'idle',
  pending_proposals jsonb not null default '[]'::jsonb,
  last_receipt jsonb,
  scope_snapshot jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists jarvis_operator_threads_actor_channel_anchor_uidx
  on public.jarvis_operator_threads (actor_key, transport_channel, anchor_fingerprint);

create index if not exists jarvis_operator_threads_actor_updated_idx
  on public.jarvis_operator_threads (actor_key, transport_channel, updated_at desc);

comment on table public.jarvis_operator_threads is
  'Jarvis spine: in-flight proposals and last receipt keyed by actor + channel + portal anchor fingerprint';

alter table public.jarvis_operator_threads enable row level security;
