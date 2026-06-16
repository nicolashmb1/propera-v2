-- Tenant portal payment display — owner-configured Zelle + Stripe Payment Links (no processing in Propera).

alter table public.properties
  add column if not exists stripe_ach_payment_link text,
  add column if not exists stripe_card_payment_link text,
  add column if not exists zelle_handle text,
  add column if not exists zelle_name text;

comment on column public.properties.stripe_ach_payment_link is
  'Owner Stripe Payment Link for bank transfer (ACH); Propera only builds prefilled URLs';
comment on column public.properties.stripe_card_payment_link is
  'Owner Stripe Payment Link for card / Apple Pay; Propera only builds prefilled URLs';
comment on column public.properties.zelle_handle is
  'Zelle email or phone shown to tenants';
comment on column public.properties.zelle_name is
  'Display name for Zelle recipient';
