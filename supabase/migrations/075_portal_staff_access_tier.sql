-- Layered staff portal access (MO-2): only applies when portal_role is Staff-like.
-- assigned_only = tickets assigned to linked staff_id only
-- operations = tickets + preventive/turnovers/amenities/comms/conflicts (no admin nav)

alter table public.portal_auth_allowlist
  add column if not exists staff_access_tier text not null default 'assigned_only';

alter table public.portal_auth_allowlist
  drop constraint if exists portal_auth_allowlist_staff_access_tier_check;

alter table public.portal_auth_allowlist
  add constraint portal_auth_allowlist_staff_access_tier_check
  check (staff_access_tier in ('assigned_only', 'operations'));

comment on column public.portal_auth_allowlist.staff_access_tier is
  'When portal_role is Staff: assigned_only (my tickets) or operations (+ module nav). Ignored for Owner/Ops/PM/Read-only.';
