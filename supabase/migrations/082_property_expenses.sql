-- Property-level operating expenses (non-maintenance): tax, insurance, utilities, payroll allocation, etc.
-- Entered manually by the PM per property. Feeds owner statement.

create table if not exists public.property_expenses (
  id                uuid primary key default gen_random_uuid(),
  property_code     text not null references public.properties (code) on delete restrict,
  expense_date      date not null,
  category          text not null,
  amount_cents      bigint not null,
  currency          text not null default 'USD',
  vendor            text not null default '',
  description       text not null default '',
  recurrence        text not null default 'one_time',
  attachment_url    text not null default '',
  status            text not null default 'posted',
  created_by        text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint property_expenses_amount_pos_chk check (amount_cents > 0),
  constraint property_expenses_category_chk check (
    category in (
      'property_tax',
      'insurance_building',
      'insurance_liability',
      'water_sewer',
      'electric',
      'gas',
      'landscaping',
      'snow_removal',
      'pest_control',
      'trash_recycling',
      'elevator_contract',
      'security_monitoring',
      'pool_maintenance',
      'hoa_condo_fees',
      'management_fee',
      'staff_payroll_allocation',
      'permits_licenses',
      'legal_accounting',
      'other'
    )
  ),
  constraint property_expenses_recurrence_chk check (
    recurrence in ('one_time', 'monthly', 'quarterly', 'annual')
  ),
  constraint property_expenses_status_chk check (
    status in ('posted', 'voided')
  )
);

comment on table public.property_expenses is
  'Operating expenses entered manually by PM per property (tax, insurance, utilities, staff allocation, management fee, etc.). '
  'Not ticket-backed. Feeds the owner income statement.';

create index if not exists property_expenses_property_date_idx
  on public.property_expenses (upper(trim(property_code)), expense_date desc);

create index if not exists property_expenses_property_status_idx
  on public.property_expenses (upper(trim(property_code)), status);

create or replace function public.property_expenses_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists property_expenses_touch_biud on public.property_expenses;
create trigger property_expenses_touch_biud
  before insert or update on public.property_expenses
  for each row
  execute procedure public.property_expenses_touch_updated_at();
