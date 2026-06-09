-- Leasehold import enrichment — other and pet deposits on file (split from LH "other deposit" bucket).

alter table public.unit_leases
  add column if not exists other_deposit_cents bigint,
  add column if not exists pet_deposit_cents bigint;

comment on column public.unit_leases.other_deposit_cents is
  'Literal Other Deposit on file (Propera enrichment from Leasehold import).';
comment on column public.unit_leases.pet_deposit_cents is
  'Pet deposit on file (Propera enrichment from Leasehold import).';

alter table public.unit_leases
  drop constraint if exists unit_leases_other_deposit_nonneg;
alter table public.unit_leases
  add constraint unit_leases_other_deposit_nonneg
    check (other_deposit_cents is null or other_deposit_cents >= 0);

alter table public.unit_leases
  drop constraint if exists unit_leases_pet_deposit_nonneg;
alter table public.unit_leases
  add constraint unit_leases_pet_deposit_nonneg
    check (pet_deposit_cents is null or pet_deposit_cents >= 0);
