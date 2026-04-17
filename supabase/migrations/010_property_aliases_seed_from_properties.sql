-- Optional seed helper for property aliases from existing properties rows.
-- Requires: 003_identity.sql + 009_property_aliases.sql
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

-- 1) Use short_name as an alias when present.
insert into public.property_aliases (property_code, alias, active)
select
  p.code,
  trim(p.short_name) as alias,
  true
from public.properties p
where coalesce(trim(p.short_name), '') <> ''
  and p.code <> 'GLOBAL'
on conflict (property_code, lower(alias)) do nothing;

-- 2) Use display_name as alias when present.
insert into public.property_aliases (property_code, alias, active)
select
  p.code,
  trim(p.display_name) as alias,
  true
from public.properties p
where coalesce(trim(p.display_name), '') <> ''
  and p.code <> 'GLOBAL'
on conflict (property_code, lower(alias)) do nothing;

-- 3) Extract a controlled street-token alias from address:
--    "702 Pennsylvania ave, Elizabeth - NJ" -> "pennsylvania"
insert into public.property_aliases (property_code, alias, active)
select
  p.code,
  initcap(m[1]) as alias,
  true
from public.properties p
cross join lateral regexp_match(
  coalesce(p.address, ''),
  '^\s*\d+\s+([A-Za-z][A-Za-z0-9]*)\s+(?:ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive)\b',
  'i'
) as m
where p.code <> 'GLOBAL'
on conflict (property_code, lower(alias)) do nothing;
