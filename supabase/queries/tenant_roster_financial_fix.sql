-- STEP 3 — Fix templates (run ONE block at a time after chat review).
-- Replace placeholders. Prefer staging first. Each statement is transactional — use BEGIN/COMMIT.
--
-- Placeholders:
--   :roster_id       uuid from active_roster_ids / active_summary
--   :property_code   e.g. WESTFIELD
--   :unit_label       e.g. 412
--   :lh_name          from comparison query
--   :phone_e164       e.g. +12015551234 (required on insert)

-- ---------------------------------------------------------------------------
-- PREVIEW before any update (always run first)
-- ---------------------------------------------------------------------------
/*
select id, property_code, unit_label, resident_name, phone_e164, active, updated_at
from public.tenant_roster
where id = ':roster_id'::uuid;
*/

-- ---------------------------------------------------------------------------
-- FIX A — Name drift: set roster name to LH full name
-- ---------------------------------------------------------------------------
/*
begin;
update public.tenant_roster
set
  resident_name = 'Maria Garcia Santos',  -- :lh_name
  notes = trim(notes || ' [reconcile ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD') || ': name synced from LH]'),
  updated_at = now()
where id = '00000000-0000-0000-0000-000000000000'::uuid  -- :roster_id
  and active = true
returning id, property_code, unit_label, resident_name, phone_e164;
-- commit;
-- rollback;
*/

-- ---------------------------------------------------------------------------
-- FIX B — Deactivate roster (LH vacant / moved out / duplicate row)
-- ---------------------------------------------------------------------------
/*
begin;
update public.tenant_roster
set
  active = false,
  notes = trim(notes || ' [reconcile ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD') || ': deactivated — LH has no tenant / turnover]'),
  updated_at = now()
where id = '00000000-0000-0000-0000-000000000000'::uuid  -- :roster_id
returning id, property_code, unit_label, resident_name, active;
-- commit;
-- rollback;
*/

-- ---------------------------------------------------------------------------
-- FIX C — Add phone from LH (name already OK)
-- ---------------------------------------------------------------------------
/*
begin;
update public.tenant_roster
set
  phone_e164 = '+12015551234',  -- :phone_e164 — normalize to E.164
  notes = trim(notes || ' [reconcile: phone from LH]'),
  updated_at = now()
where id = '00000000-0000-0000-0000-000000000000'::uuid
  and active = true
returning id, resident_name, phone_e164;
-- commit;
-- rollback;
*/

-- ---------------------------------------------------------------------------
-- FIX D — Missing roster: INSERT from LH (needs phone — get from LH or staff)
-- ---------------------------------------------------------------------------
/*
begin;
insert into public.tenant_roster (
  property_code,
  unit_label,
  phone_e164,
  resident_name,
  active,
  org_id,
  notes
)
select
  upper(trim('WESTFIELD')),           -- :property_code
  trim('412'),                        -- :unit_label
  '+12015551234',                     -- :phone_e164 — REQUIRED; parse from lh_phone_raw
  trim('Maria Garcia Santos'),        -- :lh_name
  true,
  p.org_id,
  '[reconcile ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD') || ': created from LH snapshot]'
from public.properties p
where upper(trim(p.code)) = upper(trim('WESTFIELD'))
returning id, property_code, unit_label, resident_name, phone_e164, org_id;
-- commit;
-- rollback;
*/

-- ---------------------------------------------------------------------------
-- FIX E — Bulk name sync (DANGEROUS — only after reviewing full CSV)
-- Syncs active roster name → LH where status would be name_drift, names not empty.
-- ---------------------------------------------------------------------------
/*
begin;
with
norm_units as (
  select u.id as unit_catalog_id, upper(trim(u.property_code)) as property_code,
    upper(trim(regexp_replace(trim(u.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm
  from public.units u
),
snapshots as (
  select nu.property_code, nu.unit_norm, trim(s.tenant_name_display) as lh_name
  from public.tenant_account_snapshots s
  join norm_units nu on nu.unit_catalog_id = s.unit_catalog_id
  where s.source_system = 'leasehold' and trim(s.tenant_name_display) <> ''
),
roster_active as (
  select tr.id, upper(trim(tr.property_code)) as property_code,
    upper(trim(regexp_replace(trim(tr.unit_label),
      '^(apt|apartment|suite|ste|rm|room|unit|u)\.?\s*[:#-]?\s*', '', 'i'))) as unit_norm,
    trim(tr.resident_name) as roster_name
  from public.tenant_roster tr where tr.active
),
candidates as (
  select r.id, s.lh_name, r.roster_name
  from roster_active r
  join snapshots s on s.property_code = r.property_code and s.unit_norm = r.unit_norm
  where upper(trim(r.roster_name)) <> upper(trim(s.lh_name))
    and s.lh_name like '%' || r.roster_name || '%'  -- LH is fuller; safe subset only
)
update public.tenant_roster tr
set resident_name = c.lh_name,
    notes = trim(tr.notes || ' [reconcile bulk: LH name]'),
    updated_at = now()
from candidates c
where tr.id = c.id
returning tr.id, tr.property_code, tr.unit_label, c.roster_name as old_name, tr.resident_name as new_name;
-- commit;
-- rollback;
*/

-- ---------------------------------------------------------------------------
-- STEP 4 — Re-run comparison to confirm
-- Paste tenant_roster_financial_reconcile.sql or summary again.
-- ---------------------------------------------------------------------------
