-- Staff-only amenities: enrolled in Access program but hidden from tenant portal / agent / SMS.

alter table public.access_locations
  add column if not exists staff_only boolean not null default false;

comment on column public.access_locations.staff_only is
  'When true, only staff portal / staff override may book; tenants cannot see or reserve via portal, agent, or inbound access.';
