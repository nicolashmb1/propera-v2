-- portal_tickets_v1 — expose vendor dispatch/reply fields for PM cockpit (V2 vendor lane).
-- @see docs/VENDOR_LANE.md

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
  trim(coalesce(t.assignment_updated_by, '')) as assignment_updated_by,
  trim(coalesce(t.vendor_status, '')) as vendor_status,
  trim(coalesce(t.vendor_appt, '')) as vendor_appt,
  t.vendor_dispatch_at,
  trim(coalesce(t.vendor_dispatched_to, '')) as vendor_dispatched_to
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is
  'Portal tickets + timeline_json + assignment + vendor dispatch/reply fields for PM cockpit';
