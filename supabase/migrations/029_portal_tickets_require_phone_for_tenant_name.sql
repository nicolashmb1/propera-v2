-- Empty tenant_phone_e164 must never resolve a display name: `tr.phone_e164 = ''` would match
-- arbitrary roster rows with blank phone (LIMIT 1 → wrong resident).

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
  trim(coalesce(t.source_system, '')) as source_system
from public.tickets t
where lower(trim(coalesce(t.status, ''))) <> 'deleted';

comment on view public.portal_tickets_v1 is 'Portal tickets; tenant_name only when tenant_phone_e164 is set and roster matches property+unit+phone (or contacts when ticket has no property/unit)';
