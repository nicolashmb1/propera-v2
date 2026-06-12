-- Wire PENN gameroom to Seam Yale lock (run in Supabase after migration 100).
-- Replace :seam_device_id with the device UUID from Seam console.

-- Preview current lock row
select al.slug, al.name, al.property_code, k.provider, k.external_lock_id, k.active
from public.access_locks k
join public.access_locations al on al.id = k.location_id
where al.property_code = 'PENN' and al.slug = 'gameroom';

-- Apply (uncomment and set device id)
/*
update public.access_locks k
set
  provider = 'seam',
  external_lock_id = 'f46b20dc-f066-4968-a453-8f0eae760589',
  config = '{}'::jsonb,
  updated_at = now()
from public.access_locations al
where k.location_id = al.id
  and al.property_code = 'PENN'
  and al.slug = 'gameroom'
  and k.active = true;
*/
