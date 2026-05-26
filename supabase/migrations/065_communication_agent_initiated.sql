-- Communication Engine follow-up: audit whether a campaign originated from the agent adapter.
-- Safe after 055_communication_engine.sql; no-op on fresh installs that already include the column.

alter table public.communication_campaigns
  add column if not exists agent_initiated boolean not null default false;

comment on column public.communication_campaigns.agent_initiated is
  'True when the draft originated from an agent adapter rather than a manual portal flow';
