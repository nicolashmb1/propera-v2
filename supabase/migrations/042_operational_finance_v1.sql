-- Operational finance V1: ticket cost entries, optional tenant ledger, portal read extensions.
-- Feature flags (V2 Node): PROPERA_FINANCE_ENABLED + PROPERA_FINANCE_TICKET_COSTS_ENABLED + PROPERA_FINANCE_LEDGER_ENABLED.

-- ---------------------------------------------------------------------------
-- ticket_cost_entries — property-scoped, target-based; ticket is parent in V1
-- ---------------------------------------------------------------------------
create table if not exists public.ticket_cost_entries (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  work_item_id uuid references public.work_items (id) on delete set null,
  property_code text not null references public.properties (code) on delete restrict,
  target_kind text not null,
  unit_catalog_id uuid references public.units (id) on delete set null,
  unit_label_snapshot text not null default '',
  location_id uuid references public.property_locations (id) on delete set null,
  location_label_snapshot text not null default '',
  tenant_roster_id uuid references public.tenant_roster (id) on delete set null,
  entry_type text not null,
  amount_cents bigint not null,
  currency text not null default 'USD',
  vendor_name text not null default '',
  description text not null default '',
  paid_by text not null default '',
  paid_status text not null default 'unknown',
  attachment_urls jsonb not null default '[]'::jsonb,
  tenant_charge_amount_cents bigint,
  tenant_charge_status text not null default 'not_chargeable',
  tenant_charge_reason text not null default '',
  charge_decision_by text not null default '',
  charge_decision_at timestamptz,
  ledger_posted_at timestamptz,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ticket_cost_entries_target_kind_chk check (
    target_kind in ('UNIT', 'PROPERTY_LOCATION', 'PROPERTY_WIDE', 'TURNOVER', 'PROGRAM', 'OTHER')
  ),
  constraint ticket_cost_entries_entry_type_chk check (
    entry_type in ('parts', 'labor', 'vendor_invoice', 'cleaning', 'permit', 'other')
  ),
  constraint ticket_cost_entries_paid_status_chk check (
    paid_status in ('unpaid', 'paid', 'reimbursed', 'unknown')
  ),
  constraint ticket_cost_entries_tenant_charge_status_chk check (
    tenant_charge_status in (
      'not_chargeable', 'needs_review', 'approved', 'charged', 'paid', 'waived'
    )
  ),
  constraint ticket_cost_entries_amount_nonneg_chk check (amount_cents >= 0),
  constraint ticket_cost_entries_charge_amount_nonneg_chk check (
    tenant_charge_amount_cents is null or tenant_charge_amount_cents >= 0
  )
);

comment on table public.ticket_cost_entries is
  'Operational maintenance cost + tenant charge decision per ticket; not full accounting.';

create index if not exists ticket_cost_entries_ticket_id_idx on public.ticket_cost_entries (ticket_id);
create index if not exists ticket_cost_entries_property_created_idx
  on public.ticket_cost_entries (upper(trim(property_code)), created_at desc);
create index if not exists ticket_cost_entries_unit_catalog_id_idx
  on public.ticket_cost_entries (unit_catalog_id)
  where unit_catalog_id is not null;
create index if not exists ticket_cost_entries_location_id_idx
  on public.ticket_cost_entries (location_id)
  where location_id is not null;

create or replace function public.ticket_cost_entries_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ticket_cost_entries_touch_biud on public.ticket_cost_entries;
create trigger ticket_cost_entries_touch_biud
  before insert or update on public.ticket_cost_entries
  for each row
  execute procedure public.ticket_cost_entries_touch_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_ledger_entries — posted from approved ticket charges when ledger flag on
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete restrict,
  unit_catalog_id uuid references public.units (id) on delete set null,
  tenant_roster_id uuid references public.tenant_roster (id) on delete set null,
  ticket_id uuid references public.tickets (id) on delete set null,
  source_type text not null,
  source_id uuid,
  entry_kind text not null,
  amount_cents bigint not null,
  currency text not null default 'USD',
  description text not null default '',
  status text not null default 'posted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_ledger_entries_source_chk check (
    source_type in ('ticket_cost_entry', 'manual')
  ),
  constraint tenant_ledger_entries_entry_kind_chk check (
    entry_kind in ('charge', 'payment', 'credit', 'fee', 'waiver', 'adjustment')
  ),
  constraint tenant_ledger_entries_status_chk check (
    status in ('draft', 'posted', 'paid', 'partially_paid', 'waived', 'voided')
  )
);

comment on table public.tenant_ledger_entries is
  'Tenant balance lines; ticket_cost_entry source is idempotent per cost row when ledger flag enabled.';

create unique index if not exists tenant_ledger_ticket_cost_source_uidx
  on public.tenant_ledger_entries (source_type, source_id)
  where source_type = 'ticket_cost_entry' and source_id is not null;

create index if not exists tenant_ledger_prop_idx on public.tenant_ledger_entries (upper(trim(property_code)), created_at desc);

create or replace function public.tenant_ledger_entries_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_ledger_entries_touch_biud on public.tenant_ledger_entries;
create trigger tenant_ledger_entries_touch_biud
  before insert or update on public.tenant_ledger_entries
  for each row
  execute procedure public.tenant_ledger_entries_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Read-model rollups
-- ---------------------------------------------------------------------------
create or replace view public.portal_ticket_financial_summary_v1 as
select
  c.ticket_id,
  coalesce(sum(c.amount_cents), 0)::bigint as total_cost_cents,
  coalesce(sum(coalesce(c.tenant_charge_amount_cents, 0)), 0)::bigint as total_tenant_charge_cents,
  count(*)::bigint as entry_count
from public.ticket_cost_entries c
group by c.ticket_id;

comment on view public.portal_ticket_financial_summary_v1 is
  'Per-ticket aggregates for portal cost badges and ticket detail header.';

create or replace view public.portal_property_maintenance_spend_month_v1 as
select
  upper(trim(c.property_code)) as property_code,
  (date_trunc('month', c.created_at at time zone 'UTC'))::date as month_utc,
  coalesce(sum(c.amount_cents), 0)::bigint as total_cost_cents,
  coalesce(sum(coalesce(c.tenant_charge_amount_cents, 0)), 0)::bigint as total_tenant_charge_cents,
  count(*)::bigint as entry_count
from public.ticket_cost_entries c
group by 1, 2;

comment on view public.portal_property_maintenance_spend_month_v1 is
  'UTC calendar month aggregates of ticket maintenance costs by property.';

-- ---------------------------------------------------------------------------
-- portal_properties_v1 — add current UTC month maintenance columns (030 shape)
-- ---------------------------------------------------------------------------
create or replace view public.portal_properties_v1 as
select
  trim(p.code) as property_code,
  trim(coalesce(p.display_name, p.code)) as name,
  trim(coalesce(p.short_name, '')) as short_name,
  trim(coalesce(p.ticket_prefix, '')) as ticket_prefix,
  coalesce(r.open_count, 0)::integer as open,
  coalesce(r.urgent_count, 0)::integer as urgent,
  coalesce(uc.unit_count, 0)::integer as units,
  coalesce(uc.occupied_count, 0)::integer as occupied,
  '—'::text as avg_resolution,
  '—'::text as last_activity,
  trim(coalesce(p.address, '')) as address,
  p.program_expansion_profile,
  coalesce(fin.total_cost_cents, 0)::bigint as maintenance_spend_cents_month,
  coalesce(fin.total_tenant_charge_cents, 0)::bigint as maintenance_tenant_charge_cents_month,
  coalesce(fin.entry_count, 0)::bigint as maintenance_cost_entry_count_month
from public.properties p
left join public.portal_property_rollups_v1 r
  on upper(trim(r.property_code)) = upper(trim(p.code))
left join lateral (
  select
    count(*)::integer as unit_count,
    count(*) filter (
      where lower(trim(u.status)) = 'occupied'
    )::integer as occupied_count
  from public.units u
  where upper(trim(u.property_code)) = upper(trim(p.code))
) uc on true
left join public.portal_property_maintenance_spend_month_v1 fin
  on upper(trim(fin.property_code)) = upper(trim(p.code))
  and fin.month_utc = (date_trunc('month', (current_timestamp at time zone 'UTC')))::date
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_properties_v1 is
  'Active properties with ticket KPIs, units catalog counts, and UTC-month maintenance spend.';

-- ---------------------------------------------------------------------------
-- portal_tickets_v1 — ticket_row_id + timeline colors for finance event_kind values
-- ---------------------------------------------------------------------------
create or replace view public.portal_tickets_v1 as
select
  t.ticket_id,
  t.ticket_key,
  t.tenant_phone_e164,
  case
    when trim(coalesce(t.tenant_phone_e164, '')) = '' then ''::text
    else coalesce(
      (
        select tr.resident_name
        from public.tenant_roster tr
        where tr.phone_e164 = t.tenant_phone_e164
          and tr.active = true
          and upper(trim(tr.property_code)) = upper(trim(coalesce(t.property_code, '')))
          and upper(trim(coalesce(tr.unit_label, ''))) = upper(trim(coalesce(t.unit_label, '')))
        order by tr.updated_at desc nulls last
        limit 1
      ),
      (
        select c.display_name
        from public.contacts c
        where c.phone_e164 = t.tenant_phone_e164
          and trim(coalesce(t.property_code, '')) = ''
          and trim(coalesce(t.unit_label, '')) = ''
        limit 1
      ),
      ''
    )
  end as tenant_name,
  trim(coalesce(t.property_code, '')) as property_code,
  trim(coalesce(t.property_display_name, '')) as property_display_name,
  trim(coalesce(t.unit_label, '')) as unit_label,
  trim(coalesce(t.message_raw, '')) as message_raw,
  trim(coalesce(t.category, '')) as category,
  trim(coalesce(t.category_final, '')) as category_final,
  trim(coalesce(t.status, '')) as status,
  trim(coalesce(t.priority, 'normal')) as priority,
  trim(coalesce(t.service_notes, '')) as service_notes,
  t.closed_at,
  t.created_at,
  t.updated_at,
  trim(coalesce(t.preferred_window, '')) as preferred_window,
  trim(coalesce(t.assign_to, '')) as assign_to,
  trim(coalesce(t.assigned_name, '')) as assigned_name,
  trim(coalesce(t.attachments, '')) as attachments,
  coalesce(t.is_imported_history, false) as is_imported_history,
  trim(coalesce(t.source_system, '')) as source_system,
  coalesce(
    (
      select jsonb_agg(obj order by occ asc)
      from (
        select
          e.occurred_at as occ,
          jsonb_build_object(
            'kind', trim(e.event_kind),
            'action',
              case
                when nullif(trim(e.detail), '') is null then trim(e.headline)
                else trim(e.headline) || ': ' || trim(e.detail)
              end,
            'by', case when nullif(trim(e.actor_label), '') is null then 'System' else trim(e.actor_label) end,
            'at', to_jsonb(e.occurred_at),
            'color',
              case trim(e.event_kind)
                when 'created' then '#5E6AD2'
                when 'assigned' then '#7c6fba'
                when 'scheduled' then '#c07a0a'
                when 'schedule' then '#c07a0a'
                when 'vendor_eta' then '#a06820'
                when 'eta' then '#a06820'
                when 'status_changed' then '#1a9e5f'
                when 'status' then '#1a9e5f'
                when 'resolved_closed' then '#15803d'
                when 'cost_added' then '#0d9488'
                when 'cost_updated' then '#0f766e'
                when 'tenant_charge_decision' then '#7c3aed'
                else '#6b7280'
              end
          ) as obj
        from public.ticket_timeline_events e
        where e.ticket_id = t.id
      ) sub
    ),
    '[]'::jsonb
  ) as timeline_json,
  -- Append last: CREATE OR REPLACE VIEW cannot insert a column mid-list (would rename ticket_key → ticket_row_id).
  t.id as ticket_row_id
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is
  'Portal tickets + timeline_json + ticket_row_id (UUID) for finance APIs; tenant_name scoped by property+unit+phone';
