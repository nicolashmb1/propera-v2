-- Balance-triggered lease reminders — automated Communication Engine sends.
-- Dedupe: one run per rule per calendar month; audit trail links to communication_campaigns.

create table if not exists balance_reminder_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id text not null,
  period_key text not null,
  campaign_id uuid references communication_campaigns(id) on delete set null,
  eligible_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  ran_at timestamptz not null default now(),
  constraint balance_reminder_runs_rule_period unique (rule_id, period_key)
);

create index if not exists balance_reminder_runs_ran_at_idx
  on balance_reminder_runs (ran_at desc);

comment on table balance_reminder_runs is
  'Automated balance-reminder cron audit + monthly dedupe (rule_id + YYYY-MM period_key).';
