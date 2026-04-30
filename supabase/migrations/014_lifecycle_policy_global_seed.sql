-- Minimal GLOBAL rows so GAS-style `evaluateLifecyclePolicy_` does not HOLD on missing keys.
-- Tune per property in `property_policy` as needed. Safe re-run: ON CONFLICT DO NOTHING.

insert into public.property_policy (property_code, policy_key, value, value_type) values
  ('GLOBAL', 'LIFECYCLE_ENABLED', 'true', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_REQUIRED', 'false', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_HOURS', '72', 'NUMBER'),
  ('GLOBAL', 'STAFF_UPDATE_PING_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_BUFFER_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'PARTS_WAIT_MAX_HOURS', '72', 'NUMBER'),
  ('GLOBAL', 'SCHEDULE_BUFFER_HOURS', '2', 'NUMBER')
on conflict (property_code, policy_key) do nothing;
