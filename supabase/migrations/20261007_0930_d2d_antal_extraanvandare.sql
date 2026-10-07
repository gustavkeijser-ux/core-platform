-- =====================================================================
--  D2D: antal extraanvändare (mobil) i "Vad såldes?" / "Vad ska kunden signera?".
--  Tidigare gick bara EN extraanvändare att välja (ett val i salt_mobil).
--  Nu anger säljaren antalet i fältet mobil_extra_antal (heltal, ≥ 1 när
--  "Extra användare" är vald). Antalet räknas i avtalsförslaget, Scrive-
--  avtalet, Utfall, antal avtal per kund och pinnar/lön.
--  Antal = största av: mobil_extra_antal, raderna med typ 'extra' i
--  mobil_nummer, och 1 om valet "Extra användare" finns.
-- =====================================================================

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
select od.id, od.tenant_id, 'mobil_extra_antal', 'Antal extraanvändare', 'number', false,
       '{"section":"salt","d2d_eget_ui":true,"help":"Hur många extraanvändare kunden tar (mobil)"}'::jsonb, 'all', 57
  from object_definitions od
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'mobil_extra_antal');

-- Antalet när "Extra användare" är vald: angivet antal, minst 1.
create or replace function public.d2d_extra_antal(d jsonb)
returns int language sql immutable as $$
  select greatest(1, case when coalesce(d->>'mobil_extra_antal', '') ~ '^\s*\d+(\.\d+)?\s*$'
                          then floor((d->>'mobil_extra_antal')::numeric)::int else 1 end)
$$;

-- Byt "1 om Extra användare är vald" mot det angivna antalet i alla
-- funktioner som räknar extraanvändare.
do $$
declare f text; v text; n int;
begin
  foreach f in array array['public.d2d_utfall(uuid, uuid, date, date)',
                           'public.d2d_utfall_kalla(text, uuid, uuid, date, date)',
                           'public.d2d_antal_avtal(jsonb)',
                           'public.d2d_pinnar_rader(jsonb, jsonb)'] loop
    if to_regprocedure(f) is null then continue; end if;
    v := pg_get_functiondef(f::regprocedure);
    if position('d2d_extra_antal' in v) > 0 then continue; end if;
    n := 0;
    if position('? ''extra_anvandare'' then 1 else 0 end' in v) > 0 then
      v := replace(v, 'd2d_arr(d->''salt_mobil'') ? ''extra_anvandare'' then 1 else 0 end',
                      'd2d_arr(d->''salt_mobil'') ? ''extra_anvandare'' then d2d_extra_antal(d) else 0 end');
      v := replace(v, '(select a from mob) ? ''extra_anvandare'' then 1 else 0 end',
                      '(select a from mob) ? ''extra_anvandare'' then d2d_extra_antal(d) else 0 end');
      n := 1;
    end if;
    if n = 0 or position('d2d_extra_antal' in v) = 0 then raise exception '%: hittar inte extraanvändar-villkoret', f; end if;
    execute v;
  end loop;
end $$;
