-- Per-staff Jarvis live voice visibility (admin-controlled from Settings → Jarvis).
alter table public.staff
  add column if not exists jarvis_voice_enabled boolean not null default true;

comment on column public.staff.jarvis_voice_enabled is
  'When false, staff cannot see Jarvis headset / live voice in portal chat.';

create index if not exists staff_jarvis_voice_enabled_idx
  on public.staff (org_id, jarvis_voice_enabled)
  where jarvis_voice_enabled = true;
