-- WESTFIELD Round 2 — expand single names to LH full names (approved 2026-06-11).
-- 16 renames. 311: Jason Roberts only (no Claudia row).

update public.tenant_roster set
  resident_name = 'Diego Cardona',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '101'
  and active and phone_e164 = '+18322298925';

update public.tenant_roster set
  resident_name = 'Hilda Calixto',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '202'
  and active and phone_e164 = '+17327444363';

update public.tenant_roster set
  resident_name = 'Brian Wormley',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '203'
  and active and phone_e164 = '+19737387891';

update public.tenant_roster set
  resident_name = 'Gabriel Lia',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '204'
  and active and phone_e164 = '+19087641536';

update public.tenant_roster set
  resident_name = 'Jason Alves',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '206'
  and active and phone_e164 = '+19082207685';

update public.tenant_roster set
  resident_name = 'Deborah Williams',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '208'
  and active and phone_e164 = '+12015632489';

update public.tenant_roster set
  resident_name = 'Jason M Leidy',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '210'
  and active and phone_e164 = '+19087216498';

update public.tenant_roster set
  resident_name = 'Roslyn Boone',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '211'
  and active and phone_e164 = '+19085487928';

update public.tenant_roster set
  resident_name = 'Cindy Cadet',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '212'
  and active and phone_e164 = '+19087642386';

update public.tenant_roster set
  resident_name = 'Kevin M Ashley Angulo',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '213'
  and active and phone_e164 = '+19082207071';

update public.tenant_roster set
  resident_name = 'Steven Madera',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '302'
  and active and phone_e164 = '+19084251825';

update public.tenant_roster set
  resident_name = 'Tara Newborn',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '303'
  and active and phone_e164 = '+19733808953';

update public.tenant_roster set
  resident_name = 'Cheyenne Moorman',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '306'
  and active and phone_e164 = '+19086939813';

update public.tenant_roster set
  resident_name = 'Elsa Monica Pazmino',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '307'
  and active and phone_e164 = '+19082309598';

update public.tenant_roster set
  resident_name = 'Jason Roberts',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '311'
  and active and phone_e164 = '+19082510123';

update public.tenant_roster set
  resident_name = 'Jessica Guzman',
  notes = trim(notes || ' [reconcile 2026-06-11 r2: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '314'
  and active and phone_e164 = '+19089670854';

select unit_label, resident_name, phone_e164, active
from public.tenant_roster
where upper(trim(property_code)) = 'WESTFIELD'
  and trim(unit_label) in (
    '101','202','203','204','206','208','210','211','212','213',
    '302','303','306','307','311','314'
  )
  and active
order by unit_label, resident_name;
