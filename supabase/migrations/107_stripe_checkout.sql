-- Phase 2: Stripe Checkout Sessions per property (encrypted keys) + payment audit table.

alter table public.properties
  add column if not exists stripe_secret_key_enc text,
  add column if not exists stripe_webhook_secret_enc text;

comment on column public.properties.stripe_secret_key_enc is
  'AES-GCM encrypted Stripe secret key (sk_test/sk_live); when set, tenant pay uses Checkout Sessions API';
comment on column public.properties.stripe_webhook_secret_enc is
  'AES-GCM encrypted Stripe webhook signing secret (whsec_) for POST /webhooks/stripe/:propertyCode';

-- Extend ledger source for idempotent Stripe payment posts.
alter table public.tenant_ledger_entries
  drop constraint if exists tenant_ledger_entries_source_chk;

alter table public.tenant_ledger_entries
  add constraint tenant_ledger_entries_source_chk check (
    source_type in ('ticket_cost_entry', 'manual', 'stripe_checkout')
  );

create unique index if not exists tenant_ledger_stripe_checkout_source_uidx
  on public.tenant_ledger_entries (source_type, source_id)
  where source_type = 'stripe_checkout' and source_id is not null;

create table if not exists public.tenant_stripe_payments (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete restrict,
  unit_catalog_id uuid references public.units (id) on delete set null,
  tenant_roster_id uuid references public.tenant_roster (id) on delete set null,
  checkout_session_id text not null,
  payment_intent_id text,
  payment_method text not null,
  status text not null default 'pending',
  base_cents bigint not null,
  fee_cents bigint not null default 0,
  total_cents bigint not null,
  currency text not null default 'USD',
  client_reference_id text,
  ledger_entry_id uuid references public.tenant_ledger_entries (id) on delete set null,
  stripe_event_ids jsonb not null default '[]'::jsonb,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_stripe_payments_method_chk check (payment_method in ('ach', 'card')),
  constraint tenant_stripe_payments_status_chk check (
    status in ('pending', 'processing', 'succeeded', 'failed', 'canceled')
  )
);

create unique index if not exists tenant_stripe_payments_session_uidx
  on public.tenant_stripe_payments (checkout_session_id);

create unique index if not exists tenant_stripe_payments_intent_uidx
  on public.tenant_stripe_payments (payment_intent_id)
  where payment_intent_id is not null and payment_intent_id <> '';

create index if not exists tenant_stripe_payments_unit_idx
  on public.tenant_stripe_payments (upper(trim(property_code)), unit_catalog_id, created_at desc);

comment on table public.tenant_stripe_payments is
  'Stripe Checkout Sessions created by V2; webhook updates status and links ledger payment lines';

create or replace function public.tenant_stripe_payments_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tenant_stripe_payments_touch_biud on public.tenant_stripe_payments;
create trigger tenant_stripe_payments_touch_biud
  before insert or update on public.tenant_stripe_payments
  for each row
  execute procedure public.tenant_stripe_payments_touch_updated_at();
