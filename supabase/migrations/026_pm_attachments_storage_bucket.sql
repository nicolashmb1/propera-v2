-- PM portal image uploads (propera-app → Supabase Storage → URL → V2 attaches on ticket).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pm-attachments',
  'pm-attachments',
  true,
  10485760,
  array[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read for object URLs ( writes use service role from propera-app ).
drop policy if exists "pm_attachments_select_public" on storage.objects;
create policy "pm_attachments_select_public"
  on storage.objects
  for select
  to public
  using (bucket_id = 'pm-attachments');
