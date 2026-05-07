-- Validation report for gas_sheet1_ticket_import_staging before promote.
-- Supabase SQL Editor: Find & Replace __IMPORT_BATCH_ID__ with your batch, e.g. sheet1_2026-05-06 (keep quotes).

-- Row counts
select count(*)::bigint as staging_rows
from public.gas_sheet1_ticket_import_staging
where import_batch_id = trim('__IMPORT_BATCH_ID__');

-- Duplicate ticket ids inside staging (adjust JSON key if your export uses another field)
select coalesce(trim(row_json->>'ticket_id'), trim(row_json->>'ticketId')) as ticket_id, count(*)::bigint as n
from public.gas_sheet1_ticket_import_staging
where import_batch_id = trim('__IMPORT_BATCH_ID__')
group by 1
having count(*) > 1;

-- Staging ticket ids that already exist as non-import operational rows (unexpected overlap)
select s.sheet_row,
       coalesce(trim(s.row_json->>'ticket_id'), trim(s.row_json->>'ticketId')) as ticket_id
from public.gas_sheet1_ticket_import_staging s
join public.tickets t
  on t.ticket_id = coalesce(nullif(trim(s.row_json->>'ticket_id'), ''), nullif(trim(s.row_json->>'ticketId'), ''))
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and coalesce(t.is_imported_history, false) = false;

-- Unknown property codes (adjust JSON path to your export)
select distinct trim(upper(coalesce(s.row_json->>'property_code', s.row_json->>'PROPERTY_CODE', ''))) as property_code
from public.gas_sheet1_ticket_import_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and trim(upper(coalesce(s.row_json->>'property_code', s.row_json->>'PROPERTY_CODE', ''))) <> ''
  and not exists (
    select 1 from public.properties p
    where upper(trim(p.code)) = trim(upper(coalesce(s.row_json->>'property_code', s.row_json->>'PROPERTY_CODE', '')))
  );

-- Blank required fields (customize keys)
select s.id, s.sheet_row, s.row_json
from public.gas_sheet1_ticket_import_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
  and (
    coalesce(nullif(trim(s.row_json->>'ticket_id'), ''), nullif(trim(s.row_json->>'ticketId'), '')) is null
    or trim(coalesce(s.row_json->>'property_code', s.row_json->>'PROPERTY_CODE', '')) = ''
  );
