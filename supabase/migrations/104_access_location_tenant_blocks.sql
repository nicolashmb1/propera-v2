-- Per-amenity tenant block list — staff can block a resident from booking a specific room.

create table if not exists public.access_location_tenant_blocks (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.access_locations (id) on delete cascade,
  tenant_id   uuid not null references public.tenant_roster (id) on delete cascade,
  blocked_by  text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  unique (location_id, tenant_id)
);

create index if not exists access_location_tenant_blocks_location_idx
  on public.access_location_tenant_blocks (location_id);

comment on table public.access_location_tenant_blocks is
  'Residents blocked from booking a specific access location (portal, QR, staff, agent)';
