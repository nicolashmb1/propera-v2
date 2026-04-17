-- Align `public.properties` with V2 DAL (`src/dal/propertyLookup.js` selects `legacy_property_id`,
-- `address`, `short_name`). `003_identity.sql` only had minimal columns; `004_roster_and_policy_seed.sql`
-- adds these — but installs that run 003 → 006 without 004 would error on finalize.
-- Safe if 004 already ran (IF NOT EXISTS / IF NOT EXISTS for index).

alter table public.properties
  add column if not exists legacy_property_id text,
  add column if not exists address text default '',
  add column if not exists short_name text default '';

create unique index if not exists properties_legacy_property_id_uidx
  on public.properties (legacy_property_id)
  where legacy_property_id is not null and legacy_property_id <> '';

comment on column public.properties.legacy_property_id is 'GAS property id / AppSheet PROP_*; tickets.legacy_property_id copy';
