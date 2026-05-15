-- Ticket mutation audit + timeline actor columns (P0 accountability).
-- 1) `tickets.changed_by_actor_*` — last writer snapshot (V2 sets on mutations).
-- 2) `ticket_timeline_events.actor_type/id/source` — event-time snapshot.
-- 3) `tickets_log_timeline()` reads `changed_by_*` with legacy fallback to `assigned_by` heuristics.

alter table public.tickets
  add column if not exists changed_by_actor_type text not null default '',
  add column if not exists changed_by_actor_id text not null default '',
  add column if not exists changed_by_actor_label text not null default '',
  add column if not exists changed_by_actor_source text not null default '';

comment on column public.tickets.changed_by_actor_type is
  'STAFF | SYSTEM | TENANT | UNKNOWN — last ticket mutation authority';
comment on column public.tickets.changed_by_actor_id is
  'Stable id when STAFF: staff.staff_id text; optional auth user uuid as string';
comment on column public.tickets.changed_by_actor_label is
  'Operator-facing snapshot at mutation time';
comment on column public.tickets.changed_by_actor_source is
  'propera_app | telegram | sms | policy | lifecycle | …';

alter table public.ticket_timeline_events
  add column if not exists actor_type text not null default '',
  add column if not exists actor_id text not null default '',
  add column if not exists actor_source text not null default '';

comment on column public.ticket_timeline_events.actor_type is
  'STAFF | SYSTEM | TENANT | UNKNOWN — snapshot at event time';
comment on column public.ticket_timeline_events.actor_id is
  'staff_id or other stable id when applicable';
comment on column public.ticket_timeline_events.actor_source is
  'Channel / subsystem for the actor snapshot';

create index if not exists portal_auth_allowlist_auth_user_id_idx
  on public.portal_auth_allowlist (auth_user_id)
  where auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- Timeline trigger — prefer NEW.changed_by_actor_*; improve status headline.
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
  ins_tl_label text;
  ins_tl_type text;
  ins_tl_id text;
  ins_tl_src text;
  tl_label text;
  tl_type text;
  tl_id text;
  tl_src text;
  ins_assign_actor_label text;
  ins_assign_actor_type text;
  ins_assign_actor_id text;
  ins_assign_actor_src text;
begin
  ins_actor :=
    case
      when nullif(trim(coalesce(NEW.created_by_manager, '')), '') = 'Yes' then 'Staff'
      when nullif(trim(coalesce(NEW.source_system, '')), '') <> '' then trim(NEW.source_system)
      when coalesce(NEW.tenant_phone_e164, '') <> '' then 'Tenant'
      else 'Portal'
    end;

  upd_actor :=
    case
      when nullif(trim(coalesce(NEW.assigned_by, '')), '') is null then 'Staff portal'
      when upper(trim(NEW.assigned_by)) like 'POLICY:%' then 'Policy'
      else trim(NEW.assigned_by)
    end;

  if nullif(trim(coalesce(NEW.changed_by_actor_label, '')), '') is not null then
    ins_tl_label := trim(NEW.changed_by_actor_label);
    ins_tl_type := coalesce(nullif(trim(NEW.changed_by_actor_type), ''), 'UNKNOWN');
    ins_tl_id := coalesce(nullif(trim(NEW.changed_by_actor_id), ''), '');
    ins_tl_src := coalesce(nullif(trim(NEW.changed_by_actor_source), ''), '');
  else
    ins_tl_label := ins_actor;
    ins_tl_type :=
      case
        when nullif(trim(coalesce(NEW.created_by_manager, '')), '') = 'Yes' then 'STAFF'
        when coalesce(NEW.tenant_phone_e164, '') <> '' then 'TENANT'
        when nullif(trim(coalesce(NEW.source_system, '')), '') <> '' then 'SYSTEM'
        else 'UNKNOWN'
      end;
    ins_tl_id := '';
    ins_tl_src := '';
  end if;

  if tg_op = 'INSERT' then
    insert into public.ticket_timeline_events (
      ticket_id, occurred_at, event_kind, headline, detail, actor_label,
      actor_type, actor_id, actor_source
    )
    values (
      NEW.id,
      coalesce(NEW.created_at, now()),
      'created',
      case when coalesce(NEW.is_imported_history, false) then 'Ticket imported (historical)' else 'Ticket created' end,
      '',
      ins_tl_label,
      ins_tl_type,
      ins_tl_id,
      ins_tl_src
    );

    if coalesce(trim(NEW.assigned_name), '') <> ''
       or coalesce(trim(NEW.assign_to), '') <> ''
       or coalesce(trim(NEW.assigned_id), '') <> '' then
      ins_assign_actor_label :=
        case
          when nullif(trim(coalesce(NEW.assigned_by, '')), '') is null then 'Policy'
          when upper(trim(NEW.assigned_by)) like 'POLICY:%' then 'Policy'
          else trim(NEW.assigned_by)
        end;
      ins_assign_actor_type :=
        case
          when upper(trim(coalesce(NEW.assigned_by, ''))) like 'POLICY:%' then 'SYSTEM'
          when nullif(trim(coalesce(NEW.assigned_by, '')), '') is null then 'SYSTEM'
          else 'UNKNOWN'
        end;
      ins_assign_actor_id := '';
      ins_assign_actor_src := 'policy';

      insert into public.ticket_timeline_events (
        ticket_id, occurred_at, event_kind, headline, detail, actor_label,
        actor_type, actor_id, actor_source
      )
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
        ins_assign_actor_label,
        ins_assign_actor_type,
        ins_assign_actor_id,
        ins_assign_actor_src
      );
    end if;

    return NEW;
  end if;

  if tg_op = 'UPDATE' then
    if row(
      NEW.status, NEW.assign_to, NEW.assigned_name, NEW.assigned_id, NEW.preferred_window, NEW.vendor_appt,
      NEW.message_raw, NEW.category, NEW.service_notes, NEW.priority
    ) is not distinct from row(
      OLD.status, OLD.assign_to, OLD.assigned_name, OLD.assigned_id, OLD.preferred_window, OLD.vendor_appt,
      OLD.message_raw, OLD.category, OLD.service_notes, OLD.priority
    ) then
      return NEW;
    end if;

    if nullif(trim(coalesce(NEW.changed_by_actor_label, '')), '') is not null then
      tl_label := trim(NEW.changed_by_actor_label);
      tl_type := coalesce(nullif(trim(NEW.changed_by_actor_type), ''), 'UNKNOWN');
      tl_id := coalesce(nullif(trim(NEW.changed_by_actor_id), ''), '');
      tl_src := coalesce(nullif(trim(NEW.changed_by_actor_source), ''), '');
    else
      tl_label := upd_actor;
      tl_type := 'UNKNOWN';
      tl_id := '';
      tl_src := '';
    end if;

    if coalesce(trim(OLD.assigned_name), '') is distinct from coalesce(trim(NEW.assigned_name), '')
       or coalesce(trim(OLD.assign_to), '') is distinct from coalesce(trim(NEW.assign_to), '')
       or coalesce(trim(OLD.assigned_id), '') is distinct from coalesce(trim(NEW.assigned_id), '') then
      if coalesce(trim(NEW.assigned_name), '') <> ''
         or coalesce(trim(NEW.assign_to), '') <> ''
         or coalesce(trim(NEW.assigned_id), '') <> '' then
        insert into public.ticket_timeline_events (
          ticket_id, occurred_at, event_kind, headline, detail, actor_label,
          actor_type, actor_id, actor_source
        )
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
          tl_label,
          tl_type,
          tl_id,
          tl_src
        );
      end if;
    end if;

    if coalesce(trim(OLD.preferred_window), '') is distinct from coalesce(trim(NEW.preferred_window), '')
       and coalesce(trim(NEW.preferred_window), '') <> '' then
      insert into public.ticket_timeline_events (
        ticket_id, occurred_at, event_kind, headline, detail, actor_label,
        actor_type, actor_id, actor_source
      )
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        'scheduled',
        'Scheduled',
        trim(NEW.preferred_window),
        tl_label,
        tl_type,
        tl_id,
        tl_src
      );
    end if;

    if coalesce(trim(OLD.vendor_appt), '') is distinct from coalesce(trim(NEW.vendor_appt), '')
       and coalesce(trim(NEW.vendor_appt), '') <> '' then
      insert into public.ticket_timeline_events (
        ticket_id, occurred_at, event_kind, headline, detail, actor_label,
        actor_type, actor_id, actor_source
      )
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        'vendor_eta',
        'Vendor / ETA',
        trim(NEW.vendor_appt),
        tl_label,
        tl_type,
        tl_id,
        tl_src
      );
    end if;

    if coalesce(trim(OLD.status), '') is distinct from coalesce(trim(NEW.status), '')) then
      new_st := lower(trim(coalesce(NEW.status, '')));
      term_new := new_st in (
        'completed', 'canceled', 'cancelled', 'resolved', 'closed', 'done', 'deleted'
      );
      insert into public.ticket_timeline_events (
        ticket_id, occurred_at, event_kind, headline, detail, actor_label,
        actor_type, actor_id, actor_source
      )
      values (
        NEW.id,
        coalesce(NEW.updated_at, now()),
        case when term_new then 'resolved_closed' else 'status_changed' end,
        case
          when term_new then 'Ticket ' || trim(NEW.status)
          else 'Status changed to ' || trim(NEW.status)
        end,
        case
          when term_new then ''
          when coalesce(trim(OLD.status), '') is distinct from ''
          then trim(OLD.status) || ' → ' || trim(NEW.status)
          else trim(NEW.status)
        end,
        tl_label,
        tl_type,
        tl_id,
        tl_src
      );
    end if;

    return NEW;
  end if;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- portal_tickets_v1 — timeline_json includes actor metadata
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
            'actor_type', case when nullif(trim(e.actor_type), '') is null then 'UNKNOWN' else trim(e.actor_type) end,
            'actor_id', trim(coalesce(e.actor_id, '')),
            'actor_source', trim(coalesce(e.actor_source, '')),
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
  t.id as ticket_row_id,
  trim(coalesce(t.assigned_type, '')) as assigned_type,
  trim(coalesce(t.assigned_id, '')) as assigned_id,
  t.assigned_at,
  trim(coalesce(t.assigned_by, '')) as assigned_by,
  trim(coalesce(t.assignment_source, '')) as assignment_source,
  trim(coalesce(t.assignment_note, '')) as assignment_note,
  t.assignment_updated_at,
  trim(coalesce(t.assignment_updated_by, '')) as assignment_updated_by
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is
  'Portal tickets + timeline_json + ticket_row_id + assignment metadata for PM cockpit';
