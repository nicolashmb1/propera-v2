-- Staff-configurable balance-triggered rent reminders (portal Settings UI).

create table if not exists balance_reminder_settings (
  org_id text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists balance_reminder_rules (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  rule_key text not null,
  enabled boolean not null default true,
  day_of_month smallint not null check (day_of_month >= 1 and day_of_month <= 31),
  min_balance_cents bigint not null default 1 check (min_balance_cents >= 0),
  title text not null,
  message_body text not null,
  delivery_mode text not null default 'sms_only'
    check (delivery_mode in ('sms_only', 'sms_and_portal', 'portal_only')),
  property_codes jsonb not null default '[]'::jsonb,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint balance_reminder_rules_org_key unique (org_id, rule_key)
);

create index if not exists balance_reminder_rules_org_sort_idx
  on balance_reminder_rules (org_id, sort_order, day_of_month);

comment on table balance_reminder_settings is
  'Org master switch for automated balance-triggered rent reminder SMS (Communication Engine).';
comment on table balance_reminder_rules is
  'Per-org reminder steps: day of month + balance threshold + message copy. Edited in portal Settings.';
