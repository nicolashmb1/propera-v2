-- GAS Sheet1 historical import metadata, staging table, portal indexes, read-only guard.

-- ---------------------------------------------------------------------------
-- tickets — provenance + import idempotency
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists source_system text default '',
  add column if not exists source_ticket_id text default '',
  add column if not exists source_row_hash text default '',
  add column if not exists imported_at timestamptz,
  add column if not exists import_batch_id text default '',
  add column if not exists is_imported_history boolean not null default false;

comment on column public.tickets.source_system is 'e.g. gas_sheet1 — empty for V2-native rows';
comment on column public.tickets.source_ticket_id is 'Original human ticket id from source (often equals ticket_id)';
comment on column public.tickets.source_row_hash is 'Stable hash for idempotent upsert (batch + sheet row or content hash)';
comment on column public.tickets.imported_at is 'When this historical row was loaded into Postgres';
comment on column public.tickets.import_batch_id is 'Import batch label for auditing';
comment on column public.tickets.is_imported_history is 'true = frozen GAS history (read-only); false = V2 operational';

create index if not exists tickets_created_at_desc_idx
  on public.tickets (created_at desc nulls last);

create index if not exists tickets_property_code_status_idx
  on public.tickets (property_code, status);

create index if not exists tickets_source_system_idx
  on public.tickets (source_system)
  where source_system is not null and trim(source_system) <> '';

create unique index if not exists tickets_source_system_row_hash_uidx
  on public.tickets (source_system, source_row_hash)
  where source_system is not null
    and trim(source_system) <> ''
    and source_row_hash is not null
    and trim(source_row_hash) <> '';

-- ---------------------------------------------------------------------------
-- staging — CSV / tooling loads raw rows before normalize → tickets
-- ---------------------------------------------------------------------------
create table if not exists public.gas_sheet1_ticket_import_staging (
  id bigserial primary key,
  import_batch_id text not null default '',
  sheet_row integer,
  row_json jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now()
);

create index if not exists gas_sheet1_import_staging_batch_idx
  on public.gas_sheet1_ticket_import_staging (import_batch_id);

comment on table public.gas_sheet1_ticket_import_staging is 'Raw Sheet1 rows as JSON before validation and merge into public.tickets';

-- ---------------------------------------------------------------------------
-- Block UPDATE/DELETE on imported historical tickets (service role included)
-- ---------------------------------------------------------------------------
create or replace function public.block_imported_ticket_mutation()
returns TRIGGER
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    if coalesce(OLD.is_imported_history, false) then
      raise exception 'imported_gas_ticket_read_only: ticket_id=%', OLD.ticket_id
        using errcode = 'P0001';
    end if;
    return OLD;
  elsif TG_OP = 'UPDATE' then
    if coalesce(OLD.is_imported_history, false) then
      raise exception 'imported_gas_ticket_read_only: ticket_id=%', OLD.ticket_id
        using errcode = 'P0001';
    end if;
    return NEW;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tickets_block_imported_mutation on public.tickets;
create trigger tickets_block_imported_mutation
  before update or delete on public.tickets
  for each row
  execute procedure public.block_imported_ticket_mutation();
