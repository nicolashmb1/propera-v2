-- Staff portal Web Push subscriptions (PWA Phase 2).
-- V2 owns storage + dispatch; propera-app registers subscriptions via /api/portal/push/*.

create table if not exists public.portal_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  email_lower text not null default '',
  endpoint text not null,
  p256dh text not null,
  auth_key text not null,
  user_agent text not null default '',
  notify_new_tickets boolean not null default true,
  notify_amenity_reservations boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_user_id, endpoint)
);

create index if not exists portal_push_subscriptions_active_idx
  on public.portal_push_subscriptions (active)
  where active = true;

create index if not exists portal_push_subscriptions_auth_user_idx
  on public.portal_push_subscriptions (auth_user_id);

comment on table public.portal_push_subscriptions is
  'Web Push endpoints for staff portal PWA; dispatch from V2 on new tickets and amenity reservations.';

alter table public.portal_push_subscriptions enable row level security;
