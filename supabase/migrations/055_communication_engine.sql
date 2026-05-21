-- Communication Engine V1 — broadcast campaigns, recipients, replies.
-- @see docs/COMMUNICATION_ENGINE.md

-- ---------------------------------------------------------------------------
-- Optional org row (V1 single operator; org_id on campaigns is text FK-lite)
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id text primary key,
  brand_name text not null default '',
  brand_short_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organizations is 'Operator / management company brand for tenant-facing comms';

-- ---------------------------------------------------------------------------
-- Property + roster columns for branding and broadcast opt-out
-- ---------------------------------------------------------------------------
alter table public.properties
  add column if not exists display_name_short text not null default '',
  add column if not exists comm_sender_label text not null default '';

comment on column public.properties.display_name_short is 'Short tenant-facing property label (e.g. Penn)';
comment on column public.properties.comm_sender_label is 'Optional sign-off override in broadcast SMS footers';

alter table public.tenant_roster
  add column if not exists comm_broadcast_opt_out boolean not null default false,
  add column if not exists preferred_channel text not null default 'sms';

comment on column public.tenant_roster.comm_broadcast_opt_out is
  'When true, skip broadcast campaigns (separate from maintenance sms_opt_out)';
comment on column public.tenant_roster.preferred_channel is 'sms | whatsapp — V1 send path may still be SMS-only';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type comm_type as enum (
    'BUILDING_UPDATE',
    'MAINTENANCE_NOTICE',
    'POLICY_REMINDER',
    'EMERGENCY_ALERT',
    'LEASE_ADMIN'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type comm_status as enum (
    'DRAFT',
    'QUEUED',
    'SENDING',
    'SENT',
    'PARTIALLY_SENT',
    'FAILED',
    'CANCELLED'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type comm_audience_kind as enum (
    'PORTFOLIO',
    'PROPERTY',
    'FLOOR',
    'UNIT',
    'TENANT'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type recipient_status as enum (
    'PENDING',
    'QUEUED',
    'SENT',
    'DELIVERED',
    'FAILED',
    'SKIPPED_NO_PHONE',
    'SKIPPED_OPT_OUT'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type reply_class as enum (
    'ACKNOWLEDGMENT',
    'QUESTION',
    'COMPLAINT',
    'MAINTENANCE_SIGNAL',
    'EMERGENCY_SIGNAL',
    'OPT_OUT',
    'UNKNOWN'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- communication_campaigns
-- ---------------------------------------------------------------------------
create table if not exists public.communication_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  title text not null,
  comm_type comm_type not null,
  status comm_status not null default 'DRAFT',
  audience_kind comm_audience_kind not null,
  audience_filter jsonb not null default '{}'::jsonb,
  audience_snapshot jsonb,
  message_body text not null default '',
  comm_type_key text not null default '',
  ai_assisted boolean not null default false,
  tone text not null default 'professional',
  language text not null default 'en',
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by text not null default '',
  total_recipients int not null default 0,
  total_sent int not null default 0,
  total_delivered int not null default 0,
  total_failed int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists communication_campaigns_org_status_idx
  on public.communication_campaigns (org_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- communication_recipients
-- ---------------------------------------------------------------------------
create table if not exists public.communication_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.communication_campaigns (id) on delete cascade,
  tenant_id uuid not null,
  property_code text not null,
  unit_id uuid not null references public.units (id) on delete restrict,
  unit_label_snapshot text not null default '',
  tenant_name_snapshot text not null default '',
  phone_e164_snapshot text not null default '',
  channel text not null default 'sms',
  status recipient_status not null default 'PENDING',
  twilio_message_sid text,
  error_code text,
  error_message text,
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists communication_recipients_campaign_id_idx
  on public.communication_recipients (campaign_id);

create index if not exists communication_recipients_tenant_id_idx
  on public.communication_recipients (tenant_id);

create index if not exists communication_recipients_phone_idx
  on public.communication_recipients (phone_e164_snapshot);

create index if not exists communication_recipients_twilio_sid_idx
  on public.communication_recipients (twilio_message_sid)
  where twilio_message_sid is not null;

-- ---------------------------------------------------------------------------
-- communication_replies
-- ---------------------------------------------------------------------------
create table if not exists public.communication_replies (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.communication_campaigns (id) on delete set null,
  recipient_id uuid references public.communication_recipients (id) on delete set null,
  tenant_id uuid,
  property_code text,
  unit_id uuid,
  phone_from text not null,
  message_body text not null,
  reply_class reply_class not null default 'UNKNOWN',
  twilio_message_sid text,
  auto_response_sent text not null default '',
  handoff_created boolean not null default false,
  ticket_seed_id uuid,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists communication_replies_campaign_id_idx
  on public.communication_replies (campaign_id);

create index if not exists communication_replies_tenant_id_idx
  on public.communication_replies (tenant_id);

create index if not exists communication_replies_phone_from_idx
  on public.communication_replies (phone_from);

-- ---------------------------------------------------------------------------
-- Seed: The Grand (edit org id if needed)
-- ---------------------------------------------------------------------------
insert into public.organizations (id, brand_name, brand_short_name)
values ('grand', 'The Grand Management Group', 'The Grand')
on conflict (id) do update set
  brand_name = excluded.brand_name,
  brand_short_name = excluded.brand_short_name,
  updated_at = now();

update public.properties set
  display_name = case upper(code)
    when 'PENN' then 'The Grand at Penn'
    when 'MORRIS' then 'The Grand at Morris'
    when 'MURRAY' then 'The Grand at Murray'
    when 'WESTFIELD' then 'The Grand at Westfield'
    when 'WESTGRAND' then 'The Grand at Westgrand'
    when 'WGRA' then 'The Grand at Westgrand'
    else coalesce(nullif(trim(display_name), ''), code)
  end,
  display_name_short = case upper(code)
    when 'PENN' then 'Penn'
    when 'MORRIS' then 'Morris'
    when 'MURRAY' then 'Murray'
    when 'WESTFIELD' then 'Westfield'
    when 'WESTGRAND' then 'Westgrand'
    when 'WGRA' then 'Westgrand'
    else coalesce(nullif(trim(short_name), ''), code)
  end
where upper(code) in ('PENN', 'MORRIS', 'MURRAY', 'WESTFIELD', 'WESTGRAND', 'WGRA');
