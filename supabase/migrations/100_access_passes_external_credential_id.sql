-- Store provider access-code id (e.g. Seam access_code_id) for revoke on cancel/complete.

alter table public.access_passes
  add column if not exists external_credential_id text not null default '';

comment on column public.access_passes.external_credential_id is
  'Provider credential id (Seam access_code_id, etc.) for revokeCredential.';

create index if not exists access_passes_external_credential_idx
  on public.access_passes (external_credential_id)
  where external_credential_id <> '';
