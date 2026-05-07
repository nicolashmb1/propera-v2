-- Validation for `gas_sheet1_csv_staging` after CSV import.
-- Supabase SQL Editor: use Find & Replace to change ALL occurrences of
--   __IMPORT_BATCH_ID__
-- to your batch literal, e.g. sheet1_2026-05-06 (keep the single quotes).

select count(*)::bigint as csv_rows
from public.gas_sheet1_csv_staging
where import_batch_id = trim('__IMPORT_BATCH_ID__');

select trim("TicketID") as ticket_id, count(*)::bigint as n
from public.gas_sheet1_csv_staging
where import_batch_id = trim('__IMPORT_BATCH_ID__')
group by 1
having count(*) > 1;

select trim("TicketID") as ticket_id
from public.gas_sheet1_csv_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and trim(coalesce(s."TicketID", '')) <> ''
  and exists (
    select 1 from public.tickets t
    where t.ticket_id = trim(s."TicketID")
      and coalesce(t.is_imported_history, false) = false
  );

select distinct trim(s."Property") as property_display
from public.gas_sheet1_csv_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and trim(coalesce(s."Property", '')) <> ''
  and not exists (
    select 1 from public.properties p
    where lower(trim(coalesce(p.display_name, ''))) = lower(trim(s."Property"))
       or lower(trim(coalesce(p.short_name, ''))) = lower(trim(s."Property"))
  );
