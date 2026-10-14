-- =============================================================================
-- D2D: statusen "Inte intresserad" tas bort — alla blir "Inte säljbar".
-- Feedback från Lukas 13 okt (kritisk), godkänt av Gustav 14 okt.
--
-- 1. Lägenheter med status inte_intresserad får inte_saljbar. Bytet loggas
--    som status_change på varje lägenhet (metadata.kalla = 'statussammanslagning')
--    så det går att se och backa. Anledningen (ej_intresserad_anledning) ligger kvar.
-- 2. Utfall räknar anledningarna för Inte säljbar (förut bara Inte intresserad).
-- 3. Excel-importen läser "Inte intresserad" som Inte säljbar.
-- 4. Statusvalet döljs och en trigger gör om eventuella nya till Inte säljbar.
-- 5. Nya färger (Lukas): Inte hemma grå, Signera med Scrive grönare,
--    Kall kund blåare; Inte säljbar tar över den röda färgen från Inte intresserad.
-- =============================================================================

-- 1. Byt status och logga.
with bytta as (
  update records r set status = 'inte_saljbar'
   where r.object_type = 'd2d_lagenhet' and r.status = 'inte_intresserad'
  returning r.id, r.tenant_id
)
insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind, occurred_at)
select b.tenant_id, b.id, 'status_change', 'Status ändrades till Inte säljbar (Inte intresserad togs bort)',
       jsonb_build_object('from', 'inte_intresserad', 'till', 'inte_saljbar', 'kalla', 'statussammanslagning'),
       'system', now()
  from bytta b;

-- 2. Utfall: anledningar räknas för Inte säljbar (och äldre Inte intresserad).
do $$
declare f text; v_src text;
begin
  foreach f in array array['d2d_utfall', 'd2d_utfall_kalla'] loop
    select pg_get_functiondef(p.oid) into v_src from pg_proc p
     where p.proname = f and p.pronamespace = 'public'::regnamespace;
    if position('status in (''inte_intresserad'', ''inte_saljbar'') group by 1' in v_src) > 0 then continue; end if;
    if position('from urval where status = ''inte_intresserad'' group by 1' in v_src) = 0 then
      raise exception '%: hittar inte texten', f;
    end if;
    execute replace(v_src, 'from urval where status = ''inte_intresserad'' group by 1',
                           'from urval where status in (''inte_intresserad'', ''inte_saljbar'') group by 1');
  end loop;
end $$;

-- 3. Importen.
do $$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p
   where p.proname = 'd2d_import_addresses' and p.pronamespace = 'public'::regnamespace;
  if position('when ''inte intresserad'' then ''inte_saljbar''' in v_src) > 0 then return; end if;
  if position('when ''inte intresserad'' then ''inte_intresserad''' in v_src) = 0 then
    raise exception 'd2d_import_addresses: hittar inte texten';
  end if;
  execute replace(v_src, 'when ''inte intresserad'' then ''inte_intresserad''',
                         'when ''inte intresserad'' then ''inte_saljbar''');
end $$;

-- 4. Statusvalet döljs (borttagning via MCP stoppades av tidsgräns): etiketten
--    märks som borttagen och sorteras sist, och en trigger gör om
--    inte_intresserad till inte_saljbar om en äldre appflik ändå skickar den.
update status_definitions sd set label = 'Inte intresserad (borttagen)', sort_order = 999
  from object_definitions od
 where od.id = sd.object_id and od.key = 'd2d_lagenhet' and sd.key = 'inte_intresserad';

create or replace function public.d2d_inte_intresserad_till_saljbar() returns trigger language plpgsql set search_path = public as $$
begin
  -- "Inte intresserad" är borttagen (14 okt 2026): äldre appflikar som
  -- fortfarande skickar den får Inte säljbar i stället.
  if new.object_type = 'd2d_lagenhet' and new.status = 'inte_intresserad' then
    new.status := 'inte_saljbar';
  end if;
  return new;
end $$;
revoke execute on function public.d2d_inte_intresserad_till_saljbar() from public, anon;

create or replace trigger trg_d2d_inte_intresserad
  before insert or update of status on public.records
  for each row when (new.status = 'inte_intresserad')
  execute function public.d2d_inte_intresserad_till_saljbar();

-- 5. Färger (samma som --d2d-st-* i src/styles/d2d.css).
update status_definitions sd set color = v.color
  from object_definitions od, (values
    ('inte_hemma',   '#9AA0A6'),
    ('scrive',       '#8FD694'),
    ('kall_kund',    '#4F7BD9'),
    ('inte_saljbar', '#FF0800')
  ) v(key, color)
 where od.id = sd.object_id and od.key = 'd2d_lagenhet' and sd.key = v.key;
