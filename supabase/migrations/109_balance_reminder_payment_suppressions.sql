-- Step 4 policy hook: suppress balance reminders when a mirrored payment shows paid-up (balance_after = 0).
-- Propera-only ops table — no write-back to Leasehold.

create table if not exists public.balance_reminder_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_roster_id uuid not null references public.tenant_roster (id) on delete cascade,
  period_key text not null,
  reason text not null default 'payment_received',
  source_type text not null,
  source_ref text not null,
  property_code text not null,
  unit_catalog_id uuid references public.units (id) on delete set null,
  payment_amount_cents integer not null,
  payment_effective_date date not null,
  created_at timestamptz not null default now(),
  constraint balance_reminder_suppressions_source_ref unique (source_ref)
);

create index if not exists balance_reminder_suppressions_tenant_period_idx
  on public.balance_reminder_suppressions (tenant_roster_id, period_key);

comment on table public.balance_reminder_suppressions is
  'Step 4 — skip balance-triggered SMS for tenant+month when LH-mirrored payment shows balance_after_cents = 0.';

comment on column public.balance_reminder_suppressions.period_key is
  'Calendar month YYYY-MM in PROPERA_TZ when import/policy ran (matches balance_reminder_runs.period_key).';

comment on column public.balance_reminder_suppressions.source_ref is
  'Stable dedupe key — accounting import idempotency_key or stripe payment id.';
