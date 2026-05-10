-- Transport hygiene: Twilio MessageSid (SMS/WhatsApp) dedupe — mirrors GAS ScriptCache SID layer.
-- Commit row only after successful webhook handling (see src/dal/inboundDedup.js).

create table if not exists public.inbound_dedup (
  id           bigint generated always as identity primary key,
  dedup_key    text not null unique,
  channel      text not null,
  committed_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint inbound_dedup_channel_chk check (channel in ('SMS', 'WA'))
);

create index if not exists inbound_dedup_expires_at_idx on public.inbound_dedup (expires_at);

comment on table public.inbound_dedup is 'Twilio inbound idempotency keys (SID:NOSID); TTL rows — periodic DELETE WHERE expires_at < now() optional';
