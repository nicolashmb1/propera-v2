-- Per-property: tenant pays Stripe processing fees on bank/card checkout (default on).

alter table public.properties
  add column if not exists tenant_pays_stripe_fees boolean not null default true;

comment on column public.properties.tenant_pays_stripe_fees is
  'When true, V2 adds processing fees to Stripe prefilled_amount so owner nets rent; default on';
