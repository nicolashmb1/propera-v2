-- After lease materializer import — spot-check occupied units have lease shells.
-- Replace WESTFIELD with target property.

select
  u.unit_label,
  s.tenant_name_display as lh_tenant,
  s.rent_cents as lh_rent,
  s.lease_start as lh_start,
  s.lease_end as lh_end,
  ul.rent_cents as propera_rent,
  ul.lease_start as propera_start,
  ul.lease_end as propera_end,
  ul.renewal_status,
  ul.created_by,
  ul.updated_at
from public.tenant_account_snapshots s
join public.units u on u.id = s.unit_catalog_id
left join public.unit_leases ul on ul.unit_catalog_id = s.unit_catalog_id
where upper(trim(s.property_code)) = 'WESTFIELD'
  and s.source_system = 'leasehold'
  and trim(s.tenant_name_display) <> ''
order by u.unit_label;

-- Units with LH tenant but NO unit_leases row (should be zero after materializer):
select u.unit_label, s.tenant_name_display
from public.tenant_account_snapshots s
join public.units u on u.id = s.unit_catalog_id
left join public.unit_leases ul on ul.unit_catalog_id = s.unit_catalog_id
where upper(trim(s.property_code)) = 'WESTFIELD'
  and s.source_system = 'leasehold'
  and trim(s.tenant_name_display) <> ''
  and ul.id is null
order by u.unit_label;
