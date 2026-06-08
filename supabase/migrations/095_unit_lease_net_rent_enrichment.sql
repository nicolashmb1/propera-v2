-- Propera-owned rent enrichment — gross lease rent vs tenant net obligation (subsidy / employer credit).
-- Populated from accounting import pattern detection; staff may override via lease editor.

alter table public.unit_leases
  add column if not exists tenant_net_rent_cents bigint,
  add column if not exists rent_subsidy_cents bigint,
  add column if not exists rent_subsidy_label text not null default '',
  add column if not exists net_rent_derived_at timestamptz;

comment on column public.unit_leases.tenant_net_rent_cents is
  'What the tenant pays monthly after recurring credits (Propera enrichment — not incumbent GL).';
comment on column public.unit_leases.rent_subsidy_cents is
  'Recurring monthly credit (employer, program, standing ADJ) subtracted from gross rent.';
comment on column public.unit_leases.rent_subsidy_label is
  'Optional display label for the credit (e.g. Employer, Section 8).';
comment on column public.unit_leases.net_rent_derived_at is
  'When tenant_net_rent_cents / rent_subsidy_cents were last auto-derived from import.';

alter table public.unit_leases
  drop constraint if exists unit_leases_tenant_net_rent_nonneg;
alter table public.unit_leases
  add constraint unit_leases_tenant_net_rent_nonneg
    check (tenant_net_rent_cents is null or tenant_net_rent_cents >= 0);

alter table public.unit_leases
  drop constraint if exists unit_leases_rent_subsidy_nonneg;
alter table public.unit_leases
  add constraint unit_leases_rent_subsidy_nonneg
    check (rent_subsidy_cents is null or rent_subsidy_cents >= 0);
