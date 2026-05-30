-- MO-3: per-org channel metadata (phone numbers, setup status). Platform Twilio secrets stay in env.
-- @see docs/MULTI_ORG_ARCHITECTURE.md

create table if not exists public.org_channel_configs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  channel_key text not null,
  phone_e164 text not null default '',
  display_number text not null default '',
  telegram_bot_username text not null default '',
  setup_status text not null default 'not_started',
  operator_notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_channel_configs_channel_key_check check (
    channel_key in (
      'maintenance_sms',
      'broadcast_sms',
      'tenant_otp',
      'whatsapp_maintenance',
      'telegram'
    )
  ),
  constraint org_channel_configs_setup_status_check check (
    setup_status in (
      'not_started',
      'number_saved',
      'webhook_pending',
      'active',
      'disabled'
    )
  )
);

create unique index if not exists org_channel_configs_org_key_uidx
  on public.org_channel_configs (org_id, channel_key);

create index if not exists org_channel_configs_phone_idx
  on public.org_channel_configs (phone_e164)
  where phone_e164 <> '';

comment on table public.org_channel_configs is
  'Per-org inbound/outbound channel metadata for Settings admin. Twilio account SID/auth token remain platform env only.';

comment on column public.org_channel_configs.channel_key is
  'maintenance_sms | broadcast_sms | tenant_otp | whatsapp_maintenance | telegram';

comment on column public.org_channel_configs.setup_status is
  'Operator checklist: not_started → number_saved → webhook_pending → active (or disabled).';

-- Seed default rows for existing org(s).
insert into public.org_channel_configs (org_id, channel_key)
select o.id, k.channel_key
from public.organizations o
cross join (
  values
    ('maintenance_sms'),
    ('broadcast_sms'),
    ('tenant_otp'),
    ('whatsapp_maintenance'),
    ('telegram')
) as k (channel_key)
on conflict (org_id, channel_key) do nothing;
