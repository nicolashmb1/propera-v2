-- Wide staging table for **Sheet1 CSV exports** whose headers match Google Sheets export
-- (PascalCase). Import here via Supabase Table Editor → Import data → CSV, **not** into
-- `public.tickets` (different column names). Then run promote SQL into `tickets`.
--
-- Header spellings match common exports; `"EscaletedToYou"` / `"UnitIssueCont"` mirror typos
-- sometimes present on the sheet.

create table if not exists public.gas_sheet1_csv_staging (
  id bigserial primary key,
  import_batch_id text not null default '',
  loaded_at timestamptz not null default now(),

  "Timestamp" text,
  "Phone" text,
  "Property" text,
  "Unit" text,
  "Message" text,
  "Category" text,
  "Emergency" text,
  "EmergencyType" text,
  "Urgency" text,
  "UrgencyReason" text,
  "Confidence" text,
  "NextQuestion" text,
  "AutoReply" text,
  "EscaletedToYou" text,
  "ThreadId" text,
  "TicketID" text,
  "Status" text,
  "AssignTo" text,
  "DueBy" text,
  "LastUpdatedAt" text,
  "PreferredWindow" text,
  "HandoffSent" text,
  "CategoryFinal" text,
  "Priority" text,
  "ServiceNote" text,
  "ClosedAt" text,
  "CreatedAt" text,
  "Attachments" text,
  "CompletedMsgSent" text,
  "CompleteMsgSentAt" text,
  "CreatedMsgSent" text,
  "CreatedMsgSentAt" text,
  "CreatedByManager" text,
  "CancelMsgSent" text,
  "CancelMsgSentAt" text,
  "PropertyID" text,
  "UnitID" text,
  "LocationType" text,
  "WorkType" text,
  "ResidentID" text,
  "UnitIssueCont" text,
  "TargetPropertyID" text,
  "AssignedType" text,
  "AssignedID" text,
  "AssignedName" text,
  "AssignedAt" text,
  "AssignedBy" text,
  "VendorStatus" text,
  "VendorAppt" text,
  "VendorNotes" text,
  "TicketKey" text,
  "Visits" text,
  "OwnerAction" text,
  "OwnerActionAt" text,
  "ScheduledEndAt" text
);

create index if not exists gas_sheet1_csv_staging_batch_idx
  on public.gas_sheet1_csv_staging (import_batch_id);

create index if not exists gas_sheet1_csv_staging_ticket_id_idx
  on public.gas_sheet1_csv_staging ("TicketID")
  where coalesce(trim("TicketID"), '') <> '';

comment on table public.gas_sheet1_csv_staging is 'Sheet1 CSV import staging — PascalCase columns match typical Apps Script / Sheets exports; promote into public.tickets separately';
