-- Promote `gas_sheet1_csv_staging` → `public.tickets` as historical import (`is_imported_history = true`).
-- Prerequisites: run migration `027_gas_sheet1_csv_staging.sql`, import CSV, then:
--   update public.gas_sheet1_csv_staging set import_batch_id = 'YOUR_BATCH' where import_batch_id = '';
--
-- Supabase SQL Editor: replace ALL occurrences of __IMPORT_BATCH_ID__ with your batch id
-- (same value as import_batch_id), e.g. sheet1_2026-05-06 — keep the quotes.

begin;

insert into public.tickets (
  ticket_id,
  tenant_phone_e164,
  property_code,
  property_display_name,
  unit_label,
  message_raw,
  category,
  category_final,
  status,
  priority,
  service_notes,
  preferred_window,
  assign_to,
  assigned_name,
  attachments,
  closed_at,
  created_at,
  updated_at,
  last_activity_at,
  due_by,
  ticket_key,
  timestamp_logged_at,
  emergency,
  emergency_type,
  urgency,
  urgency_reason,
  confidence,
  next_question,
  auto_reply,
  escalated_to_you,
  thread_id,
  completed_msg_sent,
  completed_msg_sent_at,
  created_msg_sent,
  created_msg_sent_at,
  created_by_manager,
  cancel_msg_sent,
  cancel_msg_sent_at,
  legacy_property_id,
  legacy_unit_id,
  location_type,
  work_type,
  resident_id,
  unit_issue_count,
  target_property_id,
  assigned_type,
  assigned_id,
  assigned_at,
  assigned_by,
  vendor_status,
  vendor_appt,
  vendor_notes,
  visit_id,
  owner_action,
  owner_action_at,
  scheduled_end_at,
  source_system,
  source_ticket_id,
  source_row_hash,
  imported_at,
  import_batch_id,
  is_imported_history
)
select
  nullif(trim(s."TicketID"), ''),
  trim(coalesce(s."Phone", '')),
  coalesce(
    (
      select upper(trim(p.code))
      from public.properties p
      where lower(trim(coalesce(p.display_name, ''))) = lower(trim(coalesce(s."Property", '')))
         or lower(trim(coalesce(p.short_name, ''))) = lower(trim(coalesce(s."Property", '')))
      limit 1
    ),
    upper(trim(coalesce(nullif(trim(s."TargetPropertyID"), ''), ''))),
    ''
  ),
  trim(coalesce(s."Property", '')),
  trim(coalesce(s."Unit", '')),
  trim(coalesce(s."Message", '')),
  trim(coalesce(s."Category", '')),
  trim(coalesce(s."CategoryFinal", '')),
  trim(coalesce(s."Status", '')),
  lower(trim(coalesce(nullif(trim(s."Priority"), ''), 'normal'))),
  trim(coalesce(s."ServiceNote", '')),
  trim(coalesce(s."PreferredWindow", '')),
  trim(coalesce(s."AssignTo", '')),
  trim(coalesce(s."AssignedName", '')),
  trim(coalesce(s."Attachments", '')),
  nullif(trim(s."ClosedAt"), '')::timestamptz,
  coalesce(nullif(trim(s."CreatedAt"), '')::timestamptz, now()),
  coalesce(nullif(trim(s."LastUpdatedAt"), '')::timestamptz, now()),
  nullif(trim(s."LastUpdatedAt"), '')::timestamptz,
  nullif(trim(s."DueBy"), '')::timestamptz,
  coalesce(nullif(trim(s."TicketKey"), ''), ''),
  nullif(trim(s."Timestamp"), '')::timestamptz,
  trim(coalesce(s."Emergency", '')),
  trim(coalesce(s."EmergencyType", '')),
  trim(coalesce(s."Urgency", '')),
  trim(coalesce(s."UrgencyReason", '')),
  case when nullif(trim(s."Confidence"), '') is null then null else trim(s."Confidence")::numeric end,
  trim(coalesce(s."NextQuestion", '')),
  trim(coalesce(s."AutoReply", '')),
  trim(coalesce(s."EscaletedToYou", '')),
  trim(coalesce(s."ThreadId", '')),
  trim(coalesce(s."CompletedMsgSent", '')),
  nullif(trim(s."CompleteMsgSentAt"), '')::timestamptz,
  trim(coalesce(s."CreatedMsgSent", '')),
  nullif(trim(s."CreatedMsgSentAt"), '')::timestamptz,
  trim(coalesce(s."CreatedByManager", '')),
  trim(coalesce(s."CancelMsgSent", '')),
  nullif(trim(s."CancelMsgSentAt"), '')::timestamptz,
  trim(coalesce(s."PropertyID", '')),
  trim(coalesce(s."UnitID", '')),
  trim(coalesce(s."LocationType", '')),
  trim(coalesce(s."WorkType", '')),
  trim(coalesce(s."ResidentID", '')),
  trim(coalesce(s."UnitIssueCont", '')),
  trim(coalesce(s."TargetPropertyID", '')),
  trim(coalesce(s."AssignedType", '')),
  trim(coalesce(s."AssignedID", '')),
  nullif(trim(s."AssignedAt"), '')::timestamptz,
  trim(coalesce(s."AssignedBy", '')),
  trim(coalesce(s."VendorStatus", '')),
  trim(coalesce(s."VendorAppt", '')),
  trim(coalesce(s."VendorNotes", '')),
  trim(coalesce(s."Visits", '')),
  trim(coalesce(s."OwnerAction", '')),
  nullif(trim(s."OwnerActionAt"), '')::timestamptz,
  nullif(trim(s."ScheduledEndAt"), '')::timestamptz,
  'gas_sheet1',
  nullif(trim(s."TicketID"), ''),
  encode(
    digest(
      trim('__IMPORT_BATCH_ID__') || '|' || s.id::text || '|' || coalesce(trim(s."TicketID"), ''),
      'sha256'
    ),
    'hex'
  ),
  now(),
  trim('__IMPORT_BATCH_ID__'),
  true
from public.gas_sheet1_csv_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and trim(coalesce(s."TicketID", '')) <> ''
on conflict (ticket_id) do update set
  updated_at = excluded.updated_at,
  attachments = excluded.attachments,
  service_notes = excluded.service_notes,
  closed_at = excluded.closed_at,
  status = excluded.status
where coalesce(public.tickets.is_imported_history, false) = true;

commit;
