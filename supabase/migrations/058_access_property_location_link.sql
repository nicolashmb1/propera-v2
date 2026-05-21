-- Link access_locations to canonical building structure (property_locations).

alter table public.access_locations
  add column if not exists property_location_id uuid
    references public.property_locations (id) on delete set null;

comment on column public.access_locations.property_location_id is
  'When set, this amenity is enrolled from Building Structure (common area); one active access row per property_location_id';

create unique index if not exists access_locations_property_location_active_uidx
  on public.access_locations (property_location_id)
  where property_location_id is not null and active = true;

-- Backfill pilot: PENN Gameroom ↔ property_locations label (case-insensitive)
update public.access_locations al
set property_location_id = pl.id
from public.property_locations pl
where al.property_code = pl.property_code
  and al.property_location_id is null
  and al.org_id = 'grand'
  and al.property_code = 'PENN'
  and al.slug = 'gameroom'
  and pl.kind = 'common_area'
  and pl.active = true
  and lower(trim(pl.label)) in ('gameroom', 'game room');
