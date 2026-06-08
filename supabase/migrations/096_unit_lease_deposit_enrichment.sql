-- Leasehold import enrichment — security and key deposits on file (from S.Dat / R.Dat).

alter table public.unit_leases
  add column if not exists key_deposit_cents bigint,
  add column if not exists deposits_derived_at timestamptz;

comment on column public.unit_leases.key_deposit_cents is
  'Key deposit on file (Propera enrichment from Leasehold import).';
comment on column public.unit_leases.deposits_derived_at is
  'When security_deposit_cents / key_deposit_cents were last auto-derived from import.';

alter table public.unit_leases
  drop constraint if exists unit_leases_key_deposit_nonneg;
alter table public.unit_leases
  add constraint unit_leases_key_deposit_nonneg
    check (key_deposit_cents is null or key_deposit_cents >= 0);
