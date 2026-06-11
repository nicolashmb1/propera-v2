-- WESTFIELD Round 1 — approved 2026-06-11
-- 14 renames, 1 deactivate (313 Viviana). 201 Katheline unchanged.
-- No begin/commit — changes persist immediately. Hard-refresh /tenants after run.

update public.tenant_roster set
  resident_name = 'Suzette Newborn',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '207'
  and active and phone_e164 = '+19082201397';

update public.tenant_roster set
  resident_name = 'Elizabeth Arboleda',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '209'
  and active and phone_e164 = '+19739790953';

update public.tenant_roster set
  resident_name = 'Carlos Mario Orozco',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '102'
  and active and phone_e164 = '+19083687599';

update public.tenant_roster set
  resident_name = 'Nathaniel Palmer',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '205'
  and active and phone_e164 = '+19738684870';

update public.tenant_roster set
  resident_name = 'Nina Palmer',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '205'
  and active and phone_e164 = '+19739517747';

update public.tenant_roster set
  resident_name = 'Jose Gomez',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '304'
  and active and phone_e164 = '+19086271492';

update public.tenant_roster set
  resident_name = 'Jessica Paola Granados',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '305'
  and active and phone_e164 = '+19735736782';

update public.tenant_roster set
  resident_name = 'Ted Louis Granados',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '305'
  and active and phone_e164 = '+19087642760';

update public.tenant_roster set
  resident_name = 'Francine Naasiababb',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '309'
  and active and phone_e164 = '+13475124059';

update public.tenant_roster set
  resident_name = 'Roberto Rivera',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '310'
  and active and phone_e164 = '+19083748392';

update public.tenant_roster set
  resident_name = 'Aurora Powell',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '312'
  and active and phone_e164 = '+19089433549';

update public.tenant_roster set
  resident_name = 'Aurora Powell',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '312'
  and active and phone_e164 = '+19085900720';

update public.tenant_roster set
  resident_name = 'Henry Marlly',
  notes = trim(notes || ' [reconcile 2026-06-11: LH name]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '313'
  and active and phone_e164 = '+19084943236';

update public.tenant_roster set
  active = false,
  notes = trim(notes || ' [reconcile 2026-06-11: deactivated — not on LH lease]'),
  updated_at = now()
where upper(trim(property_code)) = 'WESTFIELD' and trim(unit_label) = '313'
  and active and phone_e164 = '+19082202147';

select unit_label, resident_name, phone_e164, active
from public.tenant_roster
where upper(trim(property_code)) = 'WESTFIELD'
  and trim(unit_label) in ('102','205','207','209','304','305','309','310','312','313')
  and (active or notes like '%reconcile 2026-06-11%')
order by unit_label, active desc, resident_name;
