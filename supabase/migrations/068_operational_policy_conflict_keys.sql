-- Operational policy config — CME conflict.* keys on property_policy (PC-1 seed).
-- @see docs/OPERATIONAL_POLICY_CONFIG.md

insert into public.property_policy (property_code, policy_key, value, value_type)
values
  ('GLOBAL', 'conflict.monitoring_window_days', '14', 'NUMBER'),
  ('GLOBAL', 'conflict.complainant_confidentiality', 'always', 'STRING'),
  ('GLOBAL', 'conflict.auto_escalate_after_violations', '2', 'NUMBER')
on conflict (property_code, policy_key) do nothing;
