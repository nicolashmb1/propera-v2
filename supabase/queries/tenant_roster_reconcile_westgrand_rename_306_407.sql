-- WESTGRAND — rename roster to LH full names (units 306–407).
-- Matches by unit_label + phone_e164. Runs without a transaction wrapper so changes persist immediately.
-- After run: hard-refresh Propera /tenants (Ctrl+Shift+R) or wait ~30s for API cache.

update public.tenant_roster set
  resident_name = 'Rita Gillens',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '306'
  and active and phone_e164 = '+19085918461';

update public.tenant_roster set
  resident_name = 'Stephanie Kyimah James',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '307'
  and active and phone_e164 = '+19734325051';

update public.tenant_roster set
  resident_name = 'Keith Tanajah',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '401'
  and active and phone_e164 = '+19089665510';

update public.tenant_roster set
  resident_name = 'Cynthia Hill',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '402'
  and active and phone_e164 = '+17328506335';

update public.tenant_roster set
  resident_name = 'Natalia Campuzano',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '403'
  and active and phone_e164 = '+19087647364';

update public.tenant_roster set
  resident_name = 'John Neals',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '404'
  and active and phone_e164 = '+19089628066';

update public.tenant_roster set
  resident_name = 'Johanna P Franco',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '405'
  and active and phone_e164 = '+19083448304';

update public.tenant_roster set
  resident_name = 'Carmen Castillo',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '406'
  and active and phone_e164 = '+19082446552';

update public.tenant_roster set
  resident_name = 'Anthony Ferreira',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTGRAND' and trim(unit_label) = '407'
  and active and phone_e164 = '+19089673537';

select unit_label, resident_name, phone_e164, active
from public.tenant_roster
where upper(trim(property_code)) = 'WESTGRAND'
  and trim(unit_label) in ('306','307','401','402','403','404','405','406','407')
  and active
order by unit_label, resident_name;
