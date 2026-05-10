-- Turnover Engine V1 — unit-scoped lifecycle + walkthrough punch list
-- App/V2: propera-v2 DAL + portal API; tickets link via turnover_id / turnover_item_id

-- ---------------------------------------------------------------------------
-- turnovers
-- ---------------------------------------------------------------------------
create table if not exists public.turnovers (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  unit_catalog_id uuid not null references public.units (id) on delete cascade,
  unit_label_snapshot text not null,
  status text not null default 'OPEN',
  target_ready_date date null,
  actual_ready_at timestamptz null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  current_blocker text not null default '',
  summary text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint turnovers_status_chk check (
    status in ('OPEN', 'IN_PROGRESS', 'READY', 'CANCELED')
  ),
  constraint turnovers_unit_label_nonempty_chk check (length(trim(unit_label_snapshot)) > 0)
);

comment on table public.turnovers is 'Unit turnover readiness lifecycle (V1); not a ticket grouping';

create or replace function public.turnovers_normalize_row()
returns trigger
language plpgsql
as $$
begin
  new.property_code := upper(trim(new.property_code));
  new.unit_label_snapshot := trim(new.unit_label_snapshot);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists turnovers_normalize_biud on public.turnovers;
create trigger turnovers_normalize_biud
  before insert or update on public.turnovers
  for each row
  execute procedure public.turnovers_normalize_row();

create unique index if not exists turnovers_one_active_per_unit_uidx
  on public.turnovers (property_code, unit_catalog_id)
  where status not in ('READY', 'CANCELED');

create index if not exists turnovers_property_unit_idx
  on public.turnovers (property_code, unit_catalog_id);

create index if not exists turnovers_status_idx
  on public.turnovers (status);

alter table public.turnovers enable row level security;

-- ---------------------------------------------------------------------------
-- turnover_items — punch list + template lines
-- ---------------------------------------------------------------------------
create table if not exists public.turnover_items (
  id uuid primary key default gen_random_uuid(),
  turnover_id uuid not null references public.turnovers (id) on delete cascade,
  title text not null,
  detail text not null default '',
  room_or_area text not null default '',
  category text not null default '',
  priority text not null default 'NORMAL',
  status text not null default 'TODO',
  sort_order integer not null default 0,
  photo_refs jsonb not null default '[]'::jsonb,
  assigned_to text not null default '',
  due_at timestamptz null,
  linked_ticket_id text null,
  linked_work_item_id text null,
  source text not null default 'walkthrough',
  task_key text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint turnover_items_status_chk check (
    status in ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELED')
  ),
  constraint turnover_items_source_chk check (
    source in ('walkthrough', 'default_template', 'system', 'ticket')
  ),
  constraint turnover_items_title_nonempty_chk check (length(trim(title)) > 0)
);

comment on table public.turnover_items is 'Turnover punch-list rows; optional link to maintenance tickets';

create index if not exists turnover_items_turnover_sort_idx
  on public.turnover_items (turnover_id, sort_order);

create or replace function public.turnover_items_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists turnover_items_touch_biud on public.turnover_items;
create trigger turnover_items_touch_biud
  before insert or update on public.turnover_items
  for each row
  execute procedure public.turnover_items_touch_updated_at();

alter table public.turnover_items enable row level security;

-- ---------------------------------------------------------------------------
-- Tickets / work_items — turnover linkage
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists turnover_id uuid null references public.turnovers (id) on delete set null;

alter table public.tickets
  add column if not exists turnover_item_id uuid null references public.turnover_items (id) on delete set null;

create index if not exists tickets_turnover_id_idx
  on public.tickets (turnover_id)
  where turnover_id is not null;

comment on column public.tickets.turnover_id is 'Optional parent turnover for unit readiness workflow';
comment on column public.tickets.turnover_item_id is 'Turnover punch-list row that spawned this ticket';

alter table public.work_items
  add column if not exists turnover_id uuid null references public.turnovers (id) on delete set null;

create index if not exists work_items_turnover_id_idx
  on public.work_items (turnover_id)
  where turnover_id is not null;

comment on column public.work_items.turnover_id is 'Mirrors ticket turnover scope for WI-level queries';

-- ---------------------------------------------------------------------------
-- portal_turnovers_v1 — read shape for propera-app (service role)
-- ---------------------------------------------------------------------------
create or replace view public.portal_turnovers_v1 as
select
  t.id as turnover_id,
  trim(t.property_code) as property_code,
  trim(coalesce(p.display_name, p.code)) as property_display_name,
  t.unit_catalog_id,
  trim(t.unit_label_snapshot) as unit_label,
  trim(t.status) as status,
  t.target_ready_date,
  t.actual_ready_at,
  t.started_at,
  t.completed_at,
  trim(t.current_blocker) as current_blocker,
  trim(t.summary) as summary,
  t.metadata_json,
  trim(t.created_by) as created_by,
  t.created_at,
  t.updated_at
from public.turnovers t
inner join public.properties p
  on upper(trim(p.code)) = upper(trim(t.property_code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_turnovers_v1 is 'Turnovers joined to properties for portal UI';
