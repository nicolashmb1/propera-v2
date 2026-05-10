-- Ticket Timeline V1 — Activity UX fixes (run after 034).
--
-- 1) "Ticket created" no longer repeats category/unit/property (detail stays empty).
-- 2) Assignment events fire when assigned_id is set (policy often fills id before name).
-- 3) Backfill assigned + resolved_closed for tickets that changed before trigger existed
--    or only had the initial backfill row.

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

  if tg_op = 'INSERT' then
    insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
    values (
      NEW.id,
      coalesce(NEW.created_at, now()),
      'created',
      case when coalesce(NEW.is_imported_history, false) then 'Ticket imported (historical)' else 'Ticket created' end,
      '',
      ins_actor
    );

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

-- Strip noisy detail from existing "created" rows (portal detail view already shows property/unit).
update public.ticket_timeline_events
set detail = ''
where event_kind = 'created';

-- Backfill assignment when ticket row has assignee fields but no assigned event yet.
insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
select
  t.id,
  coalesce(t.assigned_at, t.created_at, now()),
  'assigned',
  'Assigned staff',
  trim(coalesce(
    nullif(trim(t.assigned_name), ''),
    nullif(trim(t.assign_to), ''),
    nullif(trim(t.assigned_id), ''),
    'Staff'
  )),
  case
    when nullif(trim(coalesce(t.assigned_by, '')), '') is null then 'Policy'
    when upper(trim(t.assigned_by)) like 'POLICY:%' then 'Policy'
    else trim(t.assigned_by)
  end
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted'
  and (
    coalesce(trim(t.assigned_name), '') <> ''
    or coalesce(trim(t.assign_to), '') <> ''
    or coalesce(trim(t.assigned_id), '') <> ''
  )
  and not exists (
    select 1
    from public.ticket_timeline_events e
    where e.ticket_id = t.id
      and e.event_kind = 'assigned'
  );

-- Backfill completion when ticket is terminal but never got resolved_closed (e.g. closed before triggers).
insert into public.ticket_timeline_events (ticket_id, occurred_at, event_kind, headline, detail, actor_label)
select
  t.id,
  coalesce(t.closed_at, t.updated_at, now()),
  'resolved_closed',
  'Ticket ' || trim(coalesce(t.status, '')),
  '',
  'Staff portal'
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted'
  and lower(trim(coalesce(t.status, ''))) in (
    'completed',
    'canceled',
    'cancelled',
    'resolved',
    'closed',
    'done',
    'deleted'
  )
  and not exists (
    select 1
    from public.ticket_timeline_events e
    where e.ticket_id = t.id
      and e.event_kind = 'resolved_closed'
  );
