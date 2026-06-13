-- Wire PENN game room / gameroom to Seam Yale lock (run in Supabase after migration 100).

-- 1) Find the amenity row (name vs slug — staff UI may use "Game Room")
select
  al.id as location_id,
  al.property_code,
  al.slug,
  al.name,
  k.id as lock_id,
  k.provider,
  k.external_lock_id,
  k.active
from public.access_locations al
left join public.access_locks k on k.location_id = al.id and k.active = true
where upper(trim(al.property_code)) = 'PENN'
  and (
    lower(trim(al.slug)) in ('gameroom', 'game-room', 'game_room')
    or lower(trim(al.name)) in ('gameroom', 'game room')
    or lower(trim(al.name)) like '%game%room%'
  );

-- 2) Apply Seam device (replace device id if yours differs)
update public.access_locks k
set
  provider = 'seam',
  external_lock_id = 'f46b20dc-f066-4968-a453-8f0eae760589',
  config = '{}'::jsonb,
  updated_at = now()
from public.access_locations al
where k.location_id = al.id
  and k.active = true
  and upper(trim(al.property_code)) = 'PENN'
  and (
    lower(trim(al.slug)) in ('gameroom', 'game-room', 'game_room')
    or lower(trim(al.name)) in ('gameroom', 'game room')
    or lower(trim(al.name)) like '%game%room%'
  );

-- 3) If step 2 still updates 0 rows, insert lock for location_id from step 1:
/*
insert into public.access_locks (org_id, location_id, provider, external_lock_id, active)
select al.org_id, al.id, 'seam', 'f46b20dc-f066-4968-a453-8f0eae760589', true
from public.access_locations al
where al.id = '<location_id from step 1>';
*/

-- 4) Verify
select al.name, k.provider, k.external_lock_id
from public.access_locks k
join public.access_locations al on al.id = k.location_id
where k.active = true
  and upper(trim(al.property_code)) = 'PENN'
  and lower(trim(al.name)) like '%game%';
