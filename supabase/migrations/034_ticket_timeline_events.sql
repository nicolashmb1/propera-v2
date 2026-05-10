-- ============================================================================
-- Ticket Timeline V1 — DB-derived activity (operator audit baseline)
-- ============================================================================
--
-- What this is:
--   Append-only rows in ticket_timeline_events driven by triggers on public.tickets.
--   Covers visible *row* changes: created, assignment, preferred_window, vendor_appt,
--   status transitions (including resolved/closed).
--
-- What this is NOT (yet):
--   Full Propera semantic / operational timeline (tenant messages, lifecycle pings,
--   timer armed/fired, policy-only decisions, etc.). Those should be emitted explicitly
--   by V2 later into the same table with distinct event_kind values — avoid duplicating
--   events that are already represented by a ticket column change (see duplicate rule below).
--
-- Duplicate rule:
--   If an outcome is visible as a tickets column diff, the DB trigger owns that event.
--   V2 should not emit a second line for the same completion (e.g. trigger already logs
--   resolved_closed when status → Completed).
--
-- Deployment order:
--   1. Apply this migration on Supabase (table + trigger + portal_tickets_v1.timeline_json).
--   2. Deploy propera-app that maps timeline_json → Activity.
--   3. Reload tickets after migration.
--
-- Noise control:
--   UPDATE path uses IS DISTINCT FROM for null-safe comparisons on tracked columns.
--   Early exit when only timestamps / columns outside the tracked set change (via ROW()
--   equality on the tracked fields only).
--
-- DB-trigger-owned event_kind values (contract — keep aligned with propera-v2 tests):
--   created | assigned | scheduled | vendor_eta | status_changed | resolved_closed
--
-- ============================================================================

create table if not exists public.ticket_timeline_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event_kind text not null,
  headline text not null,
  detail text not null default '',
  actor_label text not null default ''
);

create index if not exists ticket_timeline_events_ticket_occurred_idx
  on public.ticket_timeline_events (ticket_id, occurred_at);

comment on table public.ticket_timeline_events is
  'Ticket Timeline V1: append-only audit from tickets row changes; V2 may add semantic kinds later';

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
create or replace function public.tickets_log_timeline()
returns trigger
language plpgsql
as $$
declare
  ins_actor text;
  upd_actor text;
  new_st text;
  term_new boolean;
begin
  -- Create actor: Staff capture vs source_system vs tenant phone vs default Portal
  ins_actor :=
    case
      when nullif(trim(coalesce(NEW.created_by_manager, '')), '') = 'Yes' then 'Staff'
      when nullif(trim(coalesce(NEW.source_system, '')), '') <> '' then trim(NEW.source_system)
      when coalesce(NEW.tenant_phone_e164, '') <> '' then 'Tenant'
      else 'Portal'
    end;

  -- Update actor: hide raw POLICY:* codes from operators; else portal / human labels
  upd_actor :=
    case
      when nullif(trim(coalesce(NEW.assigned_by, '')), '') is null then 'Staff portal'
      when upper(trim(NEW.assigned_by)) like 'POLICY:%' then 'Policy'
      else trim(NEW.assigned_by)
    end;

  if tg_op = 'INSERT' then
    -- Created: headline only in Activity — unit/property/category already visible in panel header.
    insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
    values (
      NEW.id,
      coalesce(NEW.created_at, now()),
      'created',
      case when coalesce(NEW.is_imported_history, false) then 'Ticket imported (historical)' else 'Ticket created' end,
      '',
      ins_actor
    );

    -- Assignment at insert (policy often sets assigned_id before assigned_name is denormalized).
    if coalesce(trim(NEW.assigned_name), '') <> ''
       or coalesce(trim(NEW.assign_to), '') <> ''
       or coalesce(trim(NEW.assigned_id), '') <> '' then
      insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
      values (
        NEW.id,
        coalesce(NEW.assigned_at, NEW.created_at, now()),
        'assigned',
        'Assigned staff',
        trim(coalesce(
          nullif(trim(NEW.assigned_name), ''),
          nullif(trim(NEW.assign_to), ''),
          nullif(trim(NEW.assigned_id), ''),
          'Staff'
        )),
        case
          when nullif(trim(coalesce(NEW.assigned_by, '')), '') is null then 'Policy'
          when upper(trim(NEW.assigned_by)) like 'POLICY:%' then 'Policy'
          else trim(NEW.assigned_by)
        end
      );
    end if;

    return NEW;
  end if;

  if tg_op = 'UPDATE' then
    -- No tracked field changed → no timeline noise (e.g. only updated_at / last_activity_at)
    if row(
      NEW.status, NEW.assign_to, NEW.assigned_name, NEW.assigned_id, NEW.preferred_window, NEW.vendor_appt,
      NEW.message_raw, NEW.category, NEW.service_notes, NEW.priority
    ) is not distinct from row(
      OLD.status, OLD.assign_to, OLD.assigned_name, OLD.assigned_id, OLD.preferred_window, OLD.vendor_appt,
      OLD.message_raw, OLD.category, OLD.service_notes, OLD.priority
    ) then
      return NEW;
    end if;

    if coalesce(trim(OLD.assigned_name), '') is distinct from coalesce(trim(NEW.assigned_name), '')
       or coalesce(trim(OLD.assign_to), '') is distinct from coalesce(trim(NEW.assign_to), '')
       or coalesce(trim(OLD.assigned_id), '') is distinct from coalesce(trim(NEW.assigned_id), '') then
      if coalesce(trim(NEW.assigned_name), '') <> ''
         or coalesce(trim(NEW.assign_to), '') <> ''
         or coalesce(trim(NEW.assigned_id), '') <> '' then
        insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
        values (
          NEW.id,
          coalesce(NEW.updated_at, now()),
          'assigned',
          'Assigned staff',
          trim(coalesce(
            nullif(trim(NEW.assigned_name), ''),
            nullif(trim(NEW.assign_to), ''),
            nullif(trim(NEW.assigned_id), ''),
            'Staff'
          )),
          upd_actor
        );
      end if;
    end if;

    if coalesce(trim(OLD.preferred_window), '') is distinct from coalesce(trim(NEW.preferred_window), '')
       and coalesce(trim(NEW.preferred_window), '') <> '' then
      insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        'scheduled',
        'Scheduled',
        trim(NEW.preferred_window),
        upd_actor
      );
    end if;

    if coalesce(trim(OLD.vendor_appt), '') is distinct from coalesce(trim(NEW.vendor_appt), '')
       and coalesce(trim(NEW.vendor_appt), '') <> '' then
      insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        'vendor_eta',
        'Vendor / ETA',
        trim(NEW.vendor_appt),
        upd_actor
      );
    end if;

    if coalesce(trim(OLD.status), '') is distinct from coalesce(trim(NEW.status), '') then
      new_st := lower(trim(coalesce(NEW.status, '')));
      term_new := new_st in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done', 'deleted'
      );
      insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        case when term_new then 'resolved_closed' else 'status_changed' end,
        case
          when term_new then 'Ticket ' || trim(NEW.status)
          else 'Status updated'
        end,
        case
          when term_new then ''
          when coalesce(trim(OLD.status), '') is distinct from ''
          then trim(OLD.status) || ' → ' || trim(NEW.status)
          else trim(NEW.status)
        end,
        upd_actor
      );
    end if;

    return NEW;
  end if;

  return NEW;
end;
$$;

drop trigger if exists tickets_timeline_iu on public.tickets;
create trigger tickets_timeline_iu
after insert or update on public.tickets
for each row
execute function public.tickets_log_timeline();

-- ---------------------------------------------------------------------------
-- Backfill: one "created" row per ticket that has no events yet (idempotent)
-- ---------------------------------------------------------------------------
insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
select
  t.id,
  coalesce(t.created_at, now()),
  'created',
  case when coalesce(t.is_imported_history, false) then 'Ticket imported (historical)' else 'Ticket created' end,
  '',
  case
    when nullif(trim(coalesce(t.created_by_manager, '')), '') = 'Yes' then 'Staff'
    when nullif(trim(coalesce(t.source_system, '')), '') <> '' then trim(t.source_system)
    when coalesce(t.tenant_phone_e164, '') <> '' then 'Tenant'
    else 'Portal'
  end
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted'
  and not exists (
    select 1 from public.ticket_timeline_events e where e.ticket_id = t.id
  );

-- ---------------------------------------------------------------------------
-- portal_tickets_v1 + timeline_json (always coalesce to [] — never null)
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
                else '#6b7280'
              end
          ) as obj
        from public.ticket_timeline_events e
        where e.ticket_id = t.id
      ) sub
    ),
    '[]'::jsonb
  ) as timeline_json
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is
  'Portal tickets + timeline_json (Ticket Timeline V1); tenant_name scoped by property+unit+phone';
