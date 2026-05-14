-- Track last mutation on meter run photos so stuck PROCESSING rows can be reset safely.

alter table public.batch_media_assets
  add column if not exists updated_at timestamptz;

update public.batch_media_assets
set updated_at = coalesce(created_at, now())
where updated_at is null;

alter table public.batch_media_assets
  alter column updated_at set default now();

alter table public.batch_media_assets
  alter column updated_at set not null;

create or replace function public.batch_media_assets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists batch_media_assets_touch_biud on public.batch_media_assets;
create trigger batch_media_assets_touch_biud
  before insert or update on public.batch_media_assets
  for each row
  execute procedure public.batch_media_assets_touch_updated_at();

comment on column public.batch_media_assets.updated_at is 'Last row change; used to detect PROCESSING stuck after client/server disconnect';
