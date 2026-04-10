-- Telegram ↔ identity bridge (phone optional until user links / shares contact).
-- Run in Supabase SQL Editor after 001–004.

create table if not exists public.telegram_chat_link (
  telegram_chat_id text primary key,
  telegram_user_id text not null default '',
  phone_e164 text,
  last_text_preview text default '',
  updated_at timestamptz not null default now()
);

create index if not exists telegram_chat_link_user_idx on public.telegram_chat_link (telegram_user_id);
create index if not exists telegram_chat_link_phone_idx on public.telegram_chat_link (phone_e164)
  where phone_e164 is not null and phone_e164 <> '';

comment on table public.telegram_chat_link is 'Maps Telegram chat to optional phone; V2 routing when brain is ported';
