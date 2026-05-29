-- CME-2: starter structured conduct policies per property (not PDF-only).
-- @see docs/CONFLICT_MEDIATION_ENGINE.md

insert into public.conflict_policies (
  property_code,
  policy_key,
  title,
  summary,
  enforceable_text,
  default_notice_tier,
  active
)
select
  p.code,
  s.policy_key,
  s.title,
  s.summary,
  s.enforceable_text,
  'COURTESY'::conflict_notice_tier,
  true
from public.properties p
cross join (
  values
    (
      'quiet_hours',
      'Quiet hours',
      'Nighttime noise limits',
      'Quiet hours are 10:00 PM – 8:00 AM daily. Keep music, television, voices, and other noise at a level that does not disturb neighbors.'
    ),
    (
      'trash_waste',
      'Trash and waste',
      'Proper disposal of household waste',
      'Bag trash securely and place it in designated bins or chutes only. Do not leave bags, boxes, or bulk items in hallways, stairwells, or common areas.'
    ),
    (
      'parking_fire_lane',
      'Parking and fire lane',
      'Parking rules and fire lane access',
      'Do not park in fire lanes, loading zones, or reserved spaces. Keep fire lanes and building entrances clear at all times.'
    ),
    (
      'pet_policy',
      'Pet policy',
      'Pets in the building',
      'Pets must be leashed in common areas and owners must clean up after pets immediately. Persistent barking or unrestrained pets violate building policy.'
    ),
    (
      'smoking',
      'Smoking',
      'Smoke-free building areas',
      'Smoking is prohibited in common areas, hallways, stairwells, and within 25 feet of entrances unless a designated area is posted.'
    ),
    (
      'common_area_conduct',
      'Common area conduct',
      'Shared space behavior',
      'Keep lobbies, hallways, laundry rooms, and other shared spaces clean and safe. Personal items may not be stored in common areas.'
    )
) as s(policy_key, title, summary, enforceable_text)
where upper(trim(p.code)) <> 'GLOBAL'
on conflict (property_code, policy_key) do nothing;
