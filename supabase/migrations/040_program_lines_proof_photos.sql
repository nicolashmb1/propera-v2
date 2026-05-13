-- PM/Task V1 — optional proof-of-work images on checklist lines (portal preventive).
-- Values: JSON array of public http(s) URLs. Client uploads via propera-app
-- `/api/pm/upload-attachment` (bucket `pm-attachments`); V2 stores URLs only.

alter table public.program_lines
  add column if not exists proof_photo_urls jsonb not null default '[]'::jsonb;

comment on column public.program_lines.proof_photo_urls is
  'JSON array of strings — public image URLs saved when the line was completed (bounded count enforced in application). Cleared on reopen.';
