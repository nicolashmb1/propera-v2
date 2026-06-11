-- PENN Round 2 — Tier 2 deactivates (approved 2026-06-10)
-- Deactivate: 301, 408, 412, 415, 507
-- Keep active: 311 Cleber, 218 Francys, 509 Alex

begin;

update public.tenant_roster
set
  active = false,
  notes = trim(notes || ' [reconcile 2026-06-10: not on LH lease]'),
  updated_at = now()
where id in (
  '1a55b8e2-d7b9-4e86-8e84-5febaebdb320',  -- 301 Romana
  '1cdcda9c-f551-42a1-99a1-fd437b5a3437',  -- 408 Josiah
  '1f827b65-684e-4023-8c5e-f90b22897e94',  -- 412 Briana
  '88bab218-4389-4c8c-929e-092a79429b3a',  -- 415 Corey
  '702b8785-ce22-41e6-9ee7-2e244233a659'   -- 507 Jose
)
returning property_code, unit_label, resident_name, phone_e164, active;

-- commit;
-- rollback;
