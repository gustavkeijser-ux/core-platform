-- =============================================================================
-- D2D: dubbletter från dubbelimporten slås ihop (Gustav 16 okt).
--
-- Lugnets Allé 48 och Tegnérgatan 13 importerades två gånger: 12 okt med ".0"
-- i lägenhetsnummer/gatunummer ("1302.0", "48.0") och 13 okt utan. Säljarna
-- jobbade i båda kopiorna. Regel från Gustav: "1302.0" blir "1302" och inga
-- kommentarer får försvinna.
--
-- Per par (samma fastighet, gata, gatunummer, ingång, lgh-nummer):
--  * Kvar blir posten med viktigast status (såld/scrive/ånger > annan > ej
--    knackad), annars flest användaraktiviteter; lika = posten utan ".0".
--    Statusen ändras alltså aldrig (inga statustriggrar, inga mejl).
--  * Kommentarerna slås ihop (den ena innehåller den andra = den längre).
--  * Tomma fält fylls från den andra posten; säljdatum = det tidigaste.
--  * Namn och gatunummer utan ".0"; ägare behålls, annars den andras.
--  * Aktiviteter, relationer, Scrive-avtal, uppgifter, länkar och
--    nummerbytens lagenhet_id flyttas. Den andra posten mjukraderas
--    (deleted_at, data.borttagen_som_dubblett_av) och en anteckning loggas.
--  * Fastigheterna "… 48.0" / "… 13.0" byter namn.
-- Säkerhetskopia före: backup.d2d_dubbletter_20261016 (120 lägenheter).
-- Körd 16 okt 2026: 55 par. Kontroll efteråt: 0 tappade kommentarer, namn,
-- telefonnummer eller sälj; 0 lägenheter med ".0" kvar.
-- (Tidigare samma dag: 8 tomma ".0"-kopior i ingång A mjukraderades.)
-- =============================================================================
create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;
create table if not exists backup.d2d_dubbletter_20261016 as
  select now() as sparad, r.* from records r
   where r.object_type='d2d_lagenhet' and r.deleted_at is null
     and exists (select 1 from relationships rl join records f on f.id=rl.to_record_id
                  where rl.from_record_id=r.id and rl.rel_type='d2d_lag_fastighet' and f.title in ('Lugnets Allé 48.0','Tegnérgatan 13.0'));

do $$
declare
  torr boolean := false;
  r record; s records; o records; k text; v_s jsonb; v_o jsonb; komm text; ks text; ko text;
  logg text := ''; n int := 0; prio_s int; prio_o int;
begin
  for r in
    with l as (
      select l.id, rl.to_record_id fid, lower(coalesce(l.data->>'gatunamn','')) gn,
             regexp_replace(coalesce(l.data->>'gatunummer',''),'\.0$','') nr, coalesce(l.data->>'ingang','') ing,
             regexp_replace(coalesce(l.title,''),'\.0$','') nyckel, l.title ~ '\.0$' p0
        from records l left join relationships rl on rl.from_record_id=l.id and rl.rel_type='d2d_lag_fastighet'
       where l.object_type='d2d_lagenhet' and l.deleted_at is null)
    select a.id kid, b.id did, a.nyckel, a.nr from l a join l b
      on a.fid is not distinct from b.fid and a.gn=b.gn and a.nr=b.nr and a.ing=b.ing and a.nyckel=b.nyckel and not a.p0 and b.p0
  loop
    select * into s from records where id = r.kid;
    select * into o from records where id = r.did;
    -- Vilken post blir kvar: viktigast status, sedan flest användaraktiviteter, sedan senaste aktivitet; lika = posten utan .0
    prio_s := case when s.status in ('sald','scrive','anger') then 3 when s.status <> 'ej_knackad' then 2 else 1 end;
    prio_o := case when o.status in ('sald','scrive','anger') then 3 when o.status <> 'ej_knackad' then 2 else 1 end;
    if prio_o > prio_s or (prio_o = prio_s and prio_o = 2 and s.status <> o.status and
         coalesce((select max(occurred_at) from activities where record_id=o.id and actor_kind='user'),'-infinity')
       > coalesce((select max(occurred_at) from activities where record_id=s.id and actor_kind='user'),'-infinity'))
       or (prio_o = prio_s and s.status = o.status and
         (select count(*) from activities where record_id=o.id and actor_kind='user') >
         (select count(*) from activities where record_id=s.id and actor_kind='user')) then
      select * into s from records where id = r.did;
      select * into o from records where id = r.kid;
    end if;

    -- Data: tomma fält fylls från den andra posten; kommentarer slås ihop; säljdatum = det tidigaste.
    v_s := s.data;
    for k in select jsonb_object_keys(o.data) loop
      if k in ('name','gatunummer','kommentar','borttagen_som_dubblett_av') then continue; end if;
      if v_s->k is null or v_s->>k = '' or v_s->k = 'null'::jsonb or v_s->k = '[]'::jsonb or v_s->k = '{}'::jsonb then
        if not (o.data->k is null or o.data->>k = '' or o.data->k = 'null'::jsonb) then
          v_s := v_s || jsonb_build_object(k, o.data->k);
        end if;
      elsif k = 'sald_datum' and o.data->>k < v_s->>k then
        v_s := v_s || jsonb_build_object(k, o.data->k);
      end if;
    end loop;
    ks := btrim(coalesce(s.data->>'kommentar','')); ko := btrim(coalesce(o.data->>'kommentar',''));
    komm := case when ko = '' or position(ko in ks) > 0 then ks
                 when ks = '' or position(ks in ko) > 0 then ko
                 else ks || E'\n' || ko end;
    v_s := v_s || jsonb_build_object('kommentar', nullif(komm,''),
                                     'name', coalesce((select data->'name' from records where id = r.kid), to_jsonb(r.nyckel)),
                                     'gatunummer', (select data->'gatunummer' from records where id = r.kid));

    logg := logg || format(E'\n%s %s: kvar=%s(%s) bort=%s(%s) komm=%s', r.nr, r.nyckel,
       case when s.id = r.kid then 'utan.0' else 'med.0' end, s.status,
       case when o.id = r.kid then 'utan.0' else 'med.0' end, o.status, left(replace(komm, E'\n',' / '), 60));
    n := n + 1;
    if torr then continue; end if;

    update records set data = v_s, owner_user_id = coalesce(s.owner_user_id, o.owner_user_id) where id = s.id;
    update activities set record_id = s.id where record_id = o.id;
    update relationships x set from_record_id = s.id where x.from_record_id = o.id and x.rel_type <> 'd2d_lag_fastighet'
       and not exists (select 1 from relationships y where y.from_record_id = s.id and y.to_record_id = x.to_record_id and y.rel_type = x.rel_type);
    update relationships x set to_record_id = s.id where x.to_record_id = o.id
       and not exists (select 1 from relationships y where y.to_record_id = s.id and y.from_record_id = x.from_record_id and y.rel_type = x.rel_type);
    update d2d_avtal set lagenhet_id = s.id where lagenhet_id = o.id;
    update events set subject_record_id = s.id where subject_record_id = o.id;
    update tasks set record_id = s.id where record_id = o.id;
    update document_links set record_id = s.id where record_id = o.id;
    update communication_links set record_id = s.id where record_id = o.id;
    update checklist_instances set record_id = s.id where record_id = o.id;
    update checklist_items set record_id = s.id where record_id = o.id;
    update records set data = data || jsonb_build_object('lagenhet_id', s.id::text)
     where object_type = 'nummerbyte' and data->>'lagenhet_id' = o.id::text;
    update records set deleted_at = now(), data = data || jsonb_build_object('borttagen_som_dubblett_av', s.id::text)
     where id = o.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind, occurred_at)
    values (s.tenant_id, s.id, 'note',
            'Dubblett från dubbelimporten sammanslagen hit (' || o.title || ' → ' || r.nyckel || '). Kommentarer, uppgifter och historik behölls.',
            jsonb_build_object('kalla','dubblettsammanslagning','borttagen', o.id, 'kommentar_fore', jsonb_build_object('kvar', s.data->'kommentar', 'borttagen', o.data->'kommentar')),
            'system', now());
  end loop;

  if not torr then
    update records set data = data || jsonb_build_object('name', regexp_replace(title, '\.0$', ''))
     where object_type = 'd2d_fastighet' and deleted_at is null and title in ('Lugnets Allé 48.0', 'Tegnérgatan 13.0');
  end if;
  if torr then raise exception 'RESULT % par%', n, logg; end if;
  raise notice 'Sammanslaget: % par', n;
end $$;
