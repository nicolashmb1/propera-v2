-- Private bucket for unit asset nameplate photos (staff upload via propera-app service role).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'unit-asset-nameplates',
  'unit-asset-nameplates',
  false,
  8388608,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
