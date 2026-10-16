-- =============================================================================
-- D2D: flera mobilabonnemang av samma sort per kund, med varsitt nummer
-- (Gustav 16 okt: "t.ex. 2 st 10 GB, båda har varsitt nummer som ska flyttas över").
--
--  * Nytt fält mobil_antal (json, eget UI): {"10_gb": 2, ...} = antal per valt
--    abonnemang under Mobil. Saknas = 1. Extraanvändare räknas som förut
--    (mobil_extra_antal).
--  * d2d_mobil_enheter(d): ett värde per abonnemang (10_gb, 10_gb, ...).
--  * Lön/pinnar/Utfall (d2d_tjanst_rader, d2d_pinnar_rader,
--    d2d_kategori_rader), antal avtal och mobiltjänsttexten (nummerbyten,
--    Scrive) räknar varje abonnemang. Inga befintliga lägenheter har mer än
--    ett abonnemang valt, så inget historiskt ändras.
--  * Nummer att flytta: en rad typ "huvud" per abonnemang (med
--    abonnemang = sorten) + rader "extra" som förut. nb_complete kräver
--    minst så många huvudrader som abonnemang och extrarader som
--    extraanvändare, så nummerbytet skapas först när alla nummer är ifyllda.
--    (De 6 befintliga nummerbytena uppfyller redan det.)
--  * Scrive (scrive-sign) räknar priset per abonnemang × antal.
-- =============================================================================

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
select od.id, od.tenant_id, 'mobil_antal', 'Antal mobilabonnemang', 'json', false,
       '{"section":"salt","d2d_eget_ui":true,"help":"Antal per abonnemang (mobil), t.ex. 2 × 10 GB"}'::jsonb, 'all', 56
  from object_definitions od
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'mobil_antal');

create or replace function public.d2d_mobil_antal(d jsonb, p_val text)
returns int language sql immutable as $$
  select least(20, greatest(1, case when coalesce(d->'mobil_antal'->>p_val, '') ~ '^\s*\d+(\.\d+)?\s*$'
                                    then floor((d->'mobil_antal'->>p_val)::numeric)::int else 1 end))
$$;

create or replace function public.d2d_mobil_enheter(d jsonb)
returns setof text language sql immutable as $$
  select x
    from jsonb_array_elements_text(d2d_arr(d->'salt_mobil')) with ordinality as v(x, ord)
    cross join lateral generate_series(1, public.d2d_mobil_antal(d, v.x))
   where v.x <> 'extra_anvandare'
   order by v.ord
$$;
grant execute on function public.d2d_mobil_antal(jsonb, text) to authenticated, service_role;
grant execute on function public.d2d_mobil_enheter(jsonb) to authenticated, service_role;

do $$
declare v text; ny text;
begin
  -- Tjänsterader (lön, pinnar per variant).
  v := pg_get_functiondef('public.d2d_tjanst_rader(jsonb)'::regprocedure);
  if position('d2d_mobil_enheter' in v) = 0 then
    ny := replace(v, $q$select 'salt_mobil:' || x from mob, jsonb_array_elements_text(mob.a) x where x <> 'extra_anvandare'$q$,
                     $q$select 'salt_mobil:' || x from d2d_mobil_enheter(d) x$q$);
    if ny = v then raise exception 'd2d_tjanst_rader: hittar inte texten'; end if;
    execute ny;
  end if;

  v := pg_get_functiondef('public.d2d_pinnar_rader(jsonb, jsonb)'::regprocedure);
  if position('d2d_mobil_enheter' in v) = 0 then
    ny := replace(v, $q$select 'salt_mobil', x from mob, jsonb_array_elements_text(mob.a) x where x <> 'extra_anvandare'$q$,
                     $q$select 'salt_mobil', x from d2d_mobil_enheter(d) x$q$);
    if ny = v then raise exception 'd2d_pinnar_rader: hittar inte texten'; end if;
    execute ny;
  end if;

  v := pg_get_functiondef('public.d2d_kategori_rader(jsonb)'::regprocedure);
  if position('d2d_mobil_enheter' in v) = 0 then
    ny := replace(v, $q$select 'mobil_huvud' where exists (select 1 from jsonb_array_elements_text(d2d_arr(d->'salt_mobil')) x where x <> 'extra_anvandare')$q$,
                     $q$select 'mobil_huvud' from d2d_mobil_enheter(d)$q$);
    if ny = v then raise exception 'd2d_kategori_rader: hittar inte texten'; end if;
    execute ny;
  end if;

  v := pg_get_functiondef('public.d2d_antal_avtal(jsonb)'::regprocedure);
  if position('d2d_mobil_enheter' in v) = 0 then
    ny := replace(v, $q$(select count(*) from jsonb_array_elements_text(d2d_arr(d->'salt_mobil')) x where x <> 'extra_anvandare')$q$,
                     $q$(select count(*) from d2d_mobil_enheter(d))$q$);
    if ny = v then raise exception 'd2d_antal_avtal: hittar inte texten'; end if;
    execute ny;
  end if;

  v := pg_get_functiondef('public.d2d_mobiltjanst_text(jsonb, uuid)'::regprocedure);
  if position('d2d_mobil_antal' in v) = 0 then
    ny := replace(v, $q$case when x.k = 'extra_anvandare' then ' ×' || public.d2d_extra_antal(p_data) else '' end$q$,
                     $q$case when x.k = 'extra_anvandare' then ' ×' || public.d2d_extra_antal(p_data)
                     when public.d2d_mobil_antal(p_data, x.k) > 1 then ' ×' || public.d2d_mobil_antal(p_data, x.k) else '' end$q$);
    if ny = v then raise exception 'd2d_mobiltjanst_text: hittar inte texten'; end if;
    execute ny;
  end if;
end $$;

-- Nummerbytet: ett huvudnummer per abonnemang (minst ett) och ett nummer per extraanvändare.
create or replace function public.nb_complete(p_data jsonb)
returns boolean language sql immutable as $$
  select coalesce(p_data->>'mobil_startdatum', '') <> ''
     and jsonb_typeof(p_data->'mobil_nummer'->'rows') = 'array'
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'huvud')
         >= greatest(1, (select count(*) from public.d2d_mobil_enheter(p_data)))
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'extra')
         >= case when d2d_arr(p_data->'salt_mobil') ? 'extra_anvandare' then public.d2d_extra_antal(p_data) else 0 end
     and not exists (
       select 1 from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n
        where coalesce(trim(n->>'riktigt'), '') = ''
           or coalesce(trim(n->>'agare'), '') = '')
$$;
