-- GAS `SmsOptOut` / `setSmsOptOut_` parity — router compliance STOP/START persistence.
-- Key matches RouterParameter.From (E.164 or TG:…).

create table if not exists public.sms_opt_out (
  actor_key text primary key,
  opted_out boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.sms_opt_out is 'GAS SMS opt-out sheet; used by V2 router compliance + suppression.';
