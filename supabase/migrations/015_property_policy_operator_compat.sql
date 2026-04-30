-- Operator PropertyPolicy sheet → `public.property_policy` (GAS `ppGet_` keys).
-- Table shape: property_code, policy_key, value (text), value_type (BOOL | NUMBER | TEXT).
-- There is no description column; keep notes in your sheet or ops docs.
--
-- Scheduling: code reads SCHED_* via `getSchedPolicySnapshot` — includes SCHED_ALLOW_WEEKENDS
-- (legacy “both weekend days”; if false, SAT/SUN use SCHED_SAT_ALLOWED / SCHED_SUN_ALLOWED).
--
-- Idempotent: upsert so re-runs align DB with this bundle.

insert into public.property_policy (property_code, policy_key, value, value_type) values
  ('GLOBAL', 'SCHED_EARLIEST_HOUR', '9', 'NUMBER'),
  ('GLOBAL', 'SCHED_LATEST_HOUR', '17', 'NUMBER'),
  ('GLOBAL', 'SCHED_ALLOW_WEEKENDS', 'false', 'BOOL'),
  ('GLOBAL', 'SCHED_SAT_ALLOWED', 'true', 'BOOL'),
  ('GLOBAL', 'SCHED_SAT_LATEST_HOUR', '13', 'NUMBER'),
  ('GLOBAL', 'SCHED_SUN_ALLOWED', 'false', 'BOOL'),
  ('GLOBAL', 'SCHED_MIN_LEAD_HOURS', '1', 'NUMBER'),
  ('GLOBAL', 'SCHED_MAX_DAYS_OUT', '14', 'NUMBER'),

  ('PENN', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('WESTFIELD', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('WESTGRAND', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('MORRIS', 'ASSIGN_DEFAULT_OWNER', 'STAFF_GEFF', 'TEXT'),
  ('MURRAY', 'ASSIGN_DEFAULT_OWNER', 'STAFF_GEFF', 'TEXT'),

  ('GLOBAL', 'PORTAL_API_TOKEN_PM', 'DUAH3210SLXL', 'TEXT'),
  ('GLOBAL', 'POLICY_ENGINE_ENABLED', 'true', 'BOOL'),
  ('PENN', 'POLICY_ENGINE_DRY_RUN', 'false', 'BOOL'),

  ('GLOBAL', 'SCHEDULE_BUFFER_HOURS', '4', 'NUMBER'),
  ('GLOBAL', 'TENANT_VERIFY_REQUIRED', 'false', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_HOURS', '12', 'NUMBER'),
  ('GLOBAL', 'STAFF_UPDATE_PING_HOURS', '4', 'NUMBER'),
  ('GLOBAL', 'STAFF_UPDATE_MAX_ATTEMPTS', '3', 'NUMBER'),
  ('GLOBAL', 'PARTS_WAIT_MAX_HOURS', '48', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_BUFFER_HOURS', '0', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_ASK_REPEAT_HOURS', '48', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_MAX_ATTEMPTS', '2', 'NUMBER'),
  ('GLOBAL', 'LIFECYCLE_ENABLED', 'true', 'BOOL'),

  ('GLOBAL', 'CONTACT_EARLIEST_HOUR', '8', 'NUMBER'),
  ('GLOBAL', 'CONTACT_LATEST_HOUR', '18', 'NUMBER'),
  ('GLOBAL', 'CONTACT_SAT_ALLOWED', 'true', 'BOOL'),
  ('GLOBAL', 'CONTACT_SAT_LATEST_HOUR', '16', 'NUMBER'),
  ('GLOBAL', 'CONTACT_SUN_ALLOWED', 'false', 'BOOL'),
  ('GLOBAL', 'PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS', 'true', 'BOOL'),
  ('GLOBAL', 'PING_UNSCHEDULED_RESPECT_CONTACT_HOURS', 'true', 'BOOL'),
  ('GLOBAL', 'TIMER_ESCALATE_RESPECT_CONTACT_HOURS', 'true', 'BOOL'),
  ('GLOBAL', 'AUTO_CLOSE_RESPECT_CONTACT_HOURS', 'false', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_RESPECT_CONTACT_HOURS', 'true', 'BOOL'),
  ('GLOBAL', 'UNSCHEDULED_FIRST_PING_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'UNSCHEDULED_REPEAT_PING_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'UNSCHEDULED_MAX_ATTEMPTS', '3', 'NUMBER')
on conflict (property_code, policy_key) do update set
  value = excluded.value,
  value_type = excluded.value_type;
