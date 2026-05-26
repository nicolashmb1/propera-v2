-- Canonical unit status history for vacancy timing and finance-side vacancy-loss math.

create table if not exists public.unit_status_history (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units (id) on delete cascade,
  property_code text not null references public.properties (code) on delete cascade,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint unit_status_history_status_nonempty_chk check (length(trim(status)) > 0),
  constraint unit_status_history_time_order_chk check (ended_at is null or ended_at >= started_at)
);

comment on table public.unit_status_history is
  'Canonical unit status intervals. Used for vacancy timing and month-scoped vacancy-loss estimates.';

create index if not exists unit_status_history_unit_started_idx
  on public.unit_status_history (unit_id, started_at desc);

create index if not exists unit_status_history_property_started_idx
  on public.unit_status_history (upper(trim(property_code)), started_at desc);

create index if not exists unit_status_history_open_idx
  on public.unit_status_history (unit_id)
  where ended_at is null;

insert into public.unit_status_history (unit_id, property_code, status, started_at, ended_at)
select
  u.id,
  upper(trim(u.property_code)),
  trim(u.status),
  coalesce(u.updated_at, u.created_at, now()),
  null
from public.units u
where not exists (
  select 1
  from public.unit_status_history h
  where h.unit_id = u.id
    and h.ended_at is null
);

create or replace function public.units_status_history_sync()
returns trigger
language plpgsql
as $$
declare
  new_status text := trim(coalesce(new.status, ''));
  old_status text := trim(coalesce(old.status, ''));
  change_at timestamptz := coalesce(new.updated_at, now());
begin
  if tg_op = 'INSERT' then
    if length(new_status) > 0 then
      update public.unit_status_history
      set ended_at = change_at
      where unit_id = new.id
        and ended_at is null;

      insert into public.unit_status_history (unit_id, property_code, status, started_at)
      values (new.id, upper(trim(new.property_code)), new_status, change_at);
    end if;
    return new;
  end if;

  if upper(new_status) = upper(old_status) then
    return new;
  end if;

  update public.unit_status_history
  set ended_at = change_at
  where unit_id = new.id
    and ended_at is null;

  if length(new_status) > 0 then
    insert into public.unit_status_history (unit_id, property_code, status, started_at)
    values (new.id, upper(trim(new.property_code)), new_status, change_at);
  end if;

  return new;
end;
$$;

drop trigger if exists units_status_history_aiud on public.units;
create trigger units_status_history_aiud
  after insert or update on public.units
  for each row
  execute procedure public.units_status_history_sync();

create or replace view public.portal_units_v1 as
select
  u.id as unit_id,
  trim(u.property_code) as property_code,
  trim(coalesce(p.display_name, p.code)) as property_display_name,
  trim(u.unit_label) as unit_label,
  trim(coalesce(u.floor, '')) as floor,
  trim(coalesce(u.bedrooms, '')) as bedrooms,
  trim(coalesce(u.bathrooms, '')) as bathrooms,
  trim(u.status) as status,
  trim(coalesce(u.notes, '')) as notes,
  trim(coalesce(u.legacy_gas_unit_id, '')) as legacy_gas_unit_id,
  trim(coalesce(u.unit_key, '')) as unit_key,
  u.created_at,
  u.updated_at,
  vac.vacancy_started_at
from public.units u
inner join public.properties p
  on upper(trim(p.code)) = upper(trim(u.property_code))
left join lateral (
  select h.started_at as vacancy_started_at
  from public.unit_status_history h
  where h.unit_id = u.id
    and h.ended_at is null
    and lower(trim(h.status)) = 'vacant'
  order by h.started_at desc
  limit 1
) vac on true
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_units_v1 is 'Units joined to active properties for portal UI, including current vacancy-start timestamp when vacant';
