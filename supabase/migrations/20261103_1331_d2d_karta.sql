-- D2D: Karta (Door to door → Karta). Hela fastighetsbeståndet på en karta med
-- utfall per hus och dörrkvalitet (effektiva dörrar) enligt "Så planerar vi knack".
--
-- Husen är leveranserna (projektplanen, uppdateras varje timme): läge, lägenheter,
-- ägare och kundklar (= installationsdatum). Masterlistan (MASTERLISTA_SIGNADE_KUNDER,
-- bladet "Leveransdata signerade") läses in på kartsidan till d2d_karta_underlag och
-- ger befintlig lösning (låst/öppet fiber, koax, ingen) och avtalstider. Hus som bara
-- finns i Masterlistan kommer också med.
--
-- Nyckeln är fastighetsbeteckning + kommun/ort: beteckningen är unik inom kommunen,
-- inte i landet. Kommunfälten är stökiga ("Halmstads kommun", "KRISTIANSTAD",
-- "SKELLEFTEÅ EMBLA 23"), så orterna jämförs med prefix och kommunnamnet skalas
-- bort ur beteckningen.
--
-- Utfallet per hus kommer från dörrarna i husets senaste D2D-fastighet, och
-- bearbetningen (antal vändor, senast knackad) från knackhistoriken d2d_knackning.

create table if not exists public.d2d_karta_underlag (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  kommun text not null,
  ort text,
  fastighetsbeteckning text not null,
  fastighetsagare text, bolagsnamn text, adress text, postnummer text,
  lagenheter int,
  befintlig_fiber text, befintlig_koax text, kanalpaket text,
  befintlig_losning text,      -- last_fiber | oppet_fiber | koax | ingen | null (okänd)
  avtalstid_ko text, ktv_avtal text, avtal_ko_datum date, ktv_datum date,
  kundklar date, projektstatus text,
  lat double precision, lon double precision,
  kalla text,                  -- filnamnet som lästes in
  uppdaterad timestamptz not null default now()
);
create unique index if not exists d2d_karta_underlag_nyckel
  on public.d2d_karta_underlag (tenant_id, lower(kommun), lower(fastighetsbeteckning));
alter table public.d2d_karta_underlag enable row level security;

-- Nycklar -------------------------------------------------------------------

-- Ort/kommun: gemener, utan " kommun", tomt för skräp som '" DALEN 4"'.
create or replace function public.d2d_ort_nyckel(p text)
 returns text language sql immutable set search_path to 'public'
as $$ select case when coalesce(p, '') ~ '^\s*"' then ''
                  else lower(btrim(regexp_replace(coalesce(p, ''), '\s+kommun\s*$', '', 'i'))) end $$;

-- Beteckning: gemener, enkla mellanslag, utan inledande ortnamn ("SKELLEFTEÅ EMBLA 23" → "embla 23").
create or replace function public.d2d_bet_nyckel(p_bet text, p_kommun text, p_ort text)
 returns text language plpgsql immutable set search_path to 'public'
as $$
declare b text := lower(btrim(regexp_replace(coalesce(p_bet, ''), '\s+', ' ', 'g'))); x text;
begin
  foreach x in array array[d2d_ort_nyckel(p_ort), d2d_ort_nyckel(p_kommun)] loop
    if length(x) >= 3 and b like x || ' %' then b := substr(b, length(x) + 2); end if;
  end loop;
  return b;
end $$;

-- Samma ort om någon av kommun/ort stämmer, eller den ena börjar med den andra
-- ("halmstads" ~ "halmstad").
create or replace function public.d2d_samma_ort(a_kommun text, a_ort text, b_kommun text, b_ort text)
 returns boolean language sql immutable set search_path to 'public'
as $$
  select exists (
    select 1 from unnest(array[d2d_ort_nyckel(a_kommun), d2d_ort_nyckel(a_ort)]) x,
                  unnest(array[d2d_ort_nyckel(b_kommun), d2d_ort_nyckel(b_ort)]) y
     where length(x) >= 3 and length(y) >= 3 and (x = y or x like y || '%' or y like x || '%'))
$$;

-- Dörrkvalitet ----------------------------------------------------------------
-- Kvalitetsfaktor för ett hus. Faktorerna multipliceras.
-- Avtalsbanden staplas inte (inom 2 mån ×1,25, annars inom ett halvår ×1,10).
-- Knackstraffet (antal vändor × hur nyligen) har ett golv när gamla nätet släcks:
-- inom 2 mån ×0,80, 4 mån ×0,68, 6 mån ×0,55.
create or replace function public.d2d_dorrkvalitet(
  p_kundklar date, p_losning text, p_avtal_slut date, p_vandor int, p_senast timestamptz,
  p_konvertering text, p_idag date default current_date)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $function$
declare
  m numeric; f numeric := 1; d jsonb := '[]'::jsonb; v numeric; t text;
  straff numeric; golv numeric := null; am numeric;
begin
  -- Installation (kundklar). m > 0 = i framtiden. Fönstret: en månad före till två efter.
  if p_kundklar is null then v := 0.90; t := 'Installationsdatum saknas';
  else
    m := (p_kundklar - p_idag) / 30.44;
    if m between -2 and 1 then v := 1.35; t := 'Installation inom fönstret';
    elsif m > 1 and m <= 3 then v := 0.85; t := 'Installation 1–3 mån bort';
    elsif m > 3 then v := 0.55; t := 'Installation mer än 3 mån bort';
    elsif m >= -5 then v := 1.00; t := 'Installerat 2–5 mån sedan';
    else v := 0.72; t := 'Installerat för länge sedan';
    end if;
  end if;
  f := f * v; d := d || jsonb_build_object('namn', t, 'v', v);

  -- Befintlig lösning
  v := case p_losning when 'last_fiber' then 1.25 when 'koax' then 1.20 when 'ingen' then 1.05
                      when 'oppet_fiber' then 0.85 else 1.00 end;
  t := case p_losning when 'last_fiber' then 'Låst fiber' when 'koax' then 'Koax' when 'ingen' then 'Ingen befintlig lösning'
                      when 'oppet_fiber' then 'Öppet fiber' else 'Befintlig lösning okänd' end;
  f := f * v; d := d || jsonb_build_object('namn', t, 'v', v);

  -- Gamla avtalet upphör
  if p_avtal_slut is not null then
    am := (p_avtal_slut - p_idag) / 30.44;
    if am <= 2 then v := 1.25; t := 'Avtal upphör inom 2 mån'; golv := 0.80;
    elsif am <= 4 then v := 1.10; t := 'Avtal upphör inom ett halvår'; golv := 0.68;
    elsif am <= 6 then v := 1.10; t := 'Avtal upphör inom ett halvår'; golv := 0.55;
    else t := null;
    end if;
    if t is not null then f := f * v; d := d || jsonb_build_object('namn', t, 'v', v); end if;
  end if;

  -- Tidigare bearbetning
  if coalesce(p_vandor, 0) = 0 then
    f := f * 1.15; d := d || jsonb_build_object('namn', 'Aldrig knackat', 'v', 1.15);
  else
    v := case when p_vandor = 1 then 1.00 when p_vandor = 2 then 0.85 when p_vandor = 3 then 0.70 else 0.50 end;
    straff := v;
    d := d || jsonb_build_object('namn', 'Knackat ' || p_vandor || (case when p_vandor = 1 then ' gång' else ' gånger' end), 'v', v);
    if p_senast is not null then
      m := (p_idag - p_senast::date) / 30.44;
      v := case when m < 2 then 0.72 when m <= 6 then 0.90 else 1.05 end;
      t := case when m < 2 then 'Knackat inom 2 mån' when m <= 6 then 'Knackat för 2–6 mån sedan' else 'Vilat mer än ett halvår' end;
      straff := straff * v; d := d || jsonb_build_object('namn', t, 'v', v);
    end if;
    if golv is not null and straff < golv then
      d := d || jsonb_build_object('namn', 'Golv vid nedsläckning', 'v', round(golv / straff, 2));
      straff := golv;
    end if;
    f := f * straff;
  end if;

  -- Historisk konvertering (huset, annars samma ägare)
  if p_konvertering is not null then
    v := case p_konvertering when 'hog' then 1.20 when 'svag' then 0.80 else 1.05 end;
    t := case p_konvertering when 'hog' then 'Historisk konvertering hög' when 'svag' then 'Historisk konvertering svag'
              else 'Historisk konvertering normal' end;
    f := f * v; d := d || jsonb_build_object('namn', t, 'v', v);
  end if;

  return jsonb_build_object('faktor', round(f, 2), 'delar', d);
end $function$;
grant execute on function public.d2d_dorrkvalitet(date, text, date, int, timestamptz, text, date) to authenticated;

-- Inläsning av Masterlistan ----------------------------------------------------
-- p_rader: [{kommun, ort, fastighetsbeteckning, fastighetsagare, bolagsnamn, adress, postnummer,
-- lagenheter, befintlig_fiber, befintlig_koax, kanalpaket, befintlig_losning, avtalstid_ko,
-- ktv_avtal, avtal_ko_datum, ktv_datum, kundklar, projektstatus, lat, lon}]. Klassningen av
-- befintlig lösning görs i webbläsaren (D2DKarta.tsx). Befintliga rader skrivs över.
create or replace function public.d2d_karta_importera(p_rader jsonb, p_kalla text default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_t uuid := my_tenant_id(); v_n int;
begin
  if not is_admin() then raise exception 'Bara administratörer kan läsa in underlaget' using errcode = '42501'; end if;
  insert into d2d_karta_underlag as u (tenant_id, kommun, ort, fastighetsbeteckning, fastighetsagare, bolagsnamn, adress,
         postnummer, lagenheter, befintlig_fiber, befintlig_koax, kanalpaket, befintlig_losning, avtalstid_ko, ktv_avtal,
         avtal_ko_datum, ktv_datum, kundklar, projektstatus, lat, lon, kalla, uppdaterad)
  select v_t, r.kommun, r.ort, r.fastighetsbeteckning, r.fastighetsagare, r.bolagsnamn, r.adress, r.postnummer, r.lagenheter,
         r.befintlig_fiber, r.befintlig_koax, r.kanalpaket, r.befintlig_losning, r.avtalstid_ko, r.ktv_avtal,
         r.avtal_ko_datum, r.ktv_datum, r.kundklar, r.projektstatus, r.lat, r.lon, p_kalla, now()
    from jsonb_to_recordset(p_rader) as r(kommun text, ort text, fastighetsbeteckning text, fastighetsagare text,
         bolagsnamn text, adress text, postnummer text, lagenheter int, befintlig_fiber text, befintlig_koax text,
         kanalpaket text, befintlig_losning text, avtalstid_ko text, ktv_avtal text, avtal_ko_datum date, ktv_datum date,
         kundklar date, projektstatus text, lat double precision, lon double precision)
   where nullif(btrim(r.kommun), '') is not null and nullif(btrim(r.fastighetsbeteckning), '') is not null
  on conflict (tenant_id, lower(kommun), lower(fastighetsbeteckning)) do update set
    ort = excluded.ort, fastighetsagare = excluded.fastighetsagare, bolagsnamn = excluded.bolagsnamn,
    adress = excluded.adress, postnummer = excluded.postnummer, lagenheter = excluded.lagenheter,
    befintlig_fiber = excluded.befintlig_fiber, befintlig_koax = excluded.befintlig_koax, kanalpaket = excluded.kanalpaket,
    befintlig_losning = excluded.befintlig_losning, avtalstid_ko = excluded.avtalstid_ko, ktv_avtal = excluded.ktv_avtal,
    avtal_ko_datum = excluded.avtal_ko_datum, ktv_datum = excluded.ktv_datum, kundklar = excluded.kundklar,
    projektstatus = excluded.projektstatus, lat = excluded.lat, lon = excluded.lon, kalla = excluded.kalla,
    uppdaterad = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('rader', v_n, 'totalt', (select count(*) from d2d_karta_underlag where tenant_id = v_t));
end $function$;
grant execute on function public.d2d_karta_importera(jsonb, text) to authenticated;

-- Kartan ----------------------------------------------------------------------
-- Allt kartan behöver i ett anrop. Utfall per hus: s = sålt, t = aktiv Telia,
-- a = kall kund, r = återkoppling, x = ej säljbar, e = ej kontaktad/okänt.
create or replace function public.d2d_karta()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_t uuid := my_tenant_id(); v_res jsonb;
begin
  if not can_do('d2d_projekt', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;

  with lev as (
    select r.id, r.data d,
           nullif(r.data->>'kommun', '') kommun, nullif(r.data->>'ort', '') ort,
           d2d_bet_nyckel(r.data->>'fastighetsbeteckning', r.data->>'kommun', r.data->>'ort') bet
      from records r
     where r.tenant_id = v_t and r.object_type = 'delivery' and r.deleted_at is null
       and nullif(r.data->>'fastighetsbeteckning', '') is not null
  ), ml as (
    select u.*, d2d_bet_nyckel(u.fastighetsbeteckning, u.kommun, u.ort) bet
      from d2d_karta_underlag u where u.tenant_id = v_t
  ), par as (     -- leverans ↔ masterlistrad
    select distinct on (l.id) l.id lev_id, m.id ml_id
      from lev l join ml m on m.bet = l.bet and d2d_samma_ort(l.kommun, l.ort, m.kommun, m.ort)
     order by l.id, (d2d_ort_nyckel(l.kommun) = d2d_ort_nyckel(m.kommun)) desc
  ), hus as (
    select l.id, 'leverans' kalla, l.id lev_id, m.id ml_id,
           coalesce(m.kommun, case when d2d_ort_nyckel(l.kommun) <> '' then l.kommun end, l.ort) kommun,
           coalesce(l.ort, m.ort) ort, l.bet,
           coalesce(nullif(l.d->>'fastighetsbeteckning', ''), m.fastighetsbeteckning) beteckning,
           coalesce(nullif(l.d->>'fastighetsagare', ''), m.fastighetsagare) agare,
           coalesce(nullif(l.d->>'bolagsnamn', ''), m.bolagsnamn) bolag,
           coalesce(nullif(l.d->>'adress', ''), m.adress) adress,
           coalesce(nullif(l.d->>'postnummer', ''), m.postnummer) postnummer,
           coalesce(nullif(case when l.d->>'lagenheter' ~ '^\d+(\.\d+)?$' then (l.d->>'lagenheter')::numeric::int end, 0), m.lagenheter, 0) lgh,
           coalesce((l.d->>'geo_lat')::double precision, m.lat) lat, coalesce((l.d->>'geo_lon')::double precision, m.lon) lon,
           coalesce(case when l.d->>'kundklar' ~ '^\d{4}-\d{2}-\d{2}' then left(l.d->>'kundklar', 10)::date end, m.kundklar) kundklar,
           coalesce(m.avtal_ko_datum, case when l.d->>'avtalstid_ko' ~ '^\d{4}-\d{2}-\d{2}' then left(l.d->>'avtalstid_ko', 10)::date end) avtal_ko,
           coalesce(m.ktv_datum, case when l.d->>'ktv_avtal' ~ '^\d{4}-\d{2}-\d{2}' then left(l.d->>'ktv_avtal', 10)::date end) ktv,
           coalesce(m.befintlig_fiber, nullif(l.d->>'befintlig_fiberleverantor', '')) fiber, m.befintlig_koax koax,
           m.befintlig_losning losning,
           coalesce(nullif(l.d->>'projektplan_status', ''), m.projektstatus) projektstatus
      from lev l left join par p on p.lev_id = l.id left join ml m on m.id = p.ml_id
    union all
    select m.id, 'masterlista', null, m.id, m.kommun, m.ort, m.bet, m.fastighetsbeteckning,
           m.fastighetsagare, m.bolagsnamn, m.adress, m.postnummer, coalesce(m.lagenheter, 0), m.lat, m.lon, m.kundklar,
           m.avtal_ko_datum, m.ktv_datum, m.befintlig_fiber, m.befintlig_koax, m.befintlig_losning, m.projektstatus
      from ml m where not exists (select 1 from par p where p.ml_id = m.id)
  ), fast as (    -- D2D-fastighet → hus: först via länken till leveransen, annars beteckning + ort
    select f.id fast_id, f.created_at,
           coalesce(
             (select h.id from relationships rd join hus h on h.lev_id = rd.to_record_id
               where rd.from_record_id = f.id and rd.rel_type = 'd2d_fast_delivery' limit 1),
             (select h.id from hus h
               where h.bet = d2d_bet_nyckel(f.data->>'fastighetsbeteckning', f.data->>'kommun', f.data->>'ort')
                 and d2d_samma_ort(h.kommun, h.ort, f.data->>'kommun', f.data->>'ort') limit 1)) hus_id
      from records f
     where f.tenant_id = v_t and f.object_type = 'd2d_fastighet' and f.deleted_at is null
  ), senaste as (
    select distinct on (hus_id) hus_id, fast_id from fast where hus_id is not null order by hus_id, created_at desc
  ), dorr as (
    select s.hus_id, count(*) n,
           count(*) filter (where l.status in ('sald', 'scrive')) s,
           count(*) filter (where l.status = 'befintlig_telia') t,
           count(*) filter (where l.status = 'kall_kund') a,
           count(*) filter (where l.status in ('aterkoppling', 'intresserad')) r,
           count(*) filter (where l.status in ('inte_saljbar', 'anger', 'inte_intresserad')) x
      from senaste s
      join relationships rl on rl.to_record_id = s.fast_id and rl.rel_type in ('d2d_lag_fastighet', 'dorr_fastighet')
      join records l on l.id = rl.from_record_id and l.deleted_at is null and l.object_type in ('d2d_lagenhet', 'dorr')
     group by s.hus_id
  ), hist as (
    select fa.hus_id,
           count(distinct coalesce(k.projekt_id::text, to_char(k.tid, 'IYYY-IW')))::int vandor,
           count(distinct k.dorr_id)::int knackade,
           count(distinct k.dorr_id) filter (where k.status in ('sald', 'scrive'))::int salda,
           max(k.tid) senast, bool_and(k.kalla = 'aterskapad') uppskattad
      from d2d_knackning k join fast fa on fa.fast_id = k.fastighet_id
     where k.tenant_id = v_t and fa.hus_id is not null
     group by fa.hus_id
  ), agare as (
    select lower(h.agare) ag, sum(hi.knackade) kn, sum(hi.salda) sa
      from hus h join hist hi on hi.hus_id = h.id
     where nullif(h.agare, '') is not null group by 1
  ), rad as (
    select h.*, d.n, d.s, d.t, d.a, d.r, d.x, hi.vandor, hi.senast, hi.uppskattad, hi.knackade hk, hi.salda hs, ag.kn, ag.sa,
           (select min(x) from unnest(array[h.avtal_ko, h.ktv]) x where x >= current_date - 30) avtal_slut
      from hus h
      left join dorr d on d.hus_id = h.id
      left join hist hi on hi.hus_id = h.id
      left join agare ag on ag.ag = lower(h.agare)
  ), kval as (
    select r.*,
           greatest(case when coalesce(r.n, 0) > 0 then r.n - r.s - r.t - r.x else r.lgh end, 0) saljbara,
           d2d_dorrkvalitet(r.kundklar, r.losning, r.avtal_slut, coalesce(r.vandor, 0), r.senast,
             case when coalesce(r.hk, 0) >= 15 then
                    case when r.hs::numeric / r.hk >= 0.25 then 'hog' when r.hs::numeric / r.hk < 0.10 then 'svag' else 'normal' end
                  when coalesce(r.kn, 0) >= 30 then
                    case when r.sa::numeric / r.kn >= 0.25 then 'hog' when r.sa::numeric / r.kn < 0.10 then 'svag' else 'normal' end
             end) kv
      from rad r
  )
  select jsonb_build_object('idag', current_date,
    'underlag', (select jsonb_build_object('rader', count(*), 'kalla', max(kalla), 'uppdaterad', max(uppdaterad))
                   from d2d_karta_underlag where tenant_id = v_t),
    'fastigheter', coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'kalla', q.kalla, 'levId', q.lev_id, 'kommun', q.kommun, 'ort', q.ort, 'beteckning', q.beteckning,
      'agare', q.agare, 'bolag', q.bolag, 'adress', q.adress, 'postnummer', q.postnummer, 'lgh', q.lgh,
      'lat', q.lat, 'lon', q.lon, 'fiber', q.fiber, 'koax', q.koax, 'losning', q.losning,
      'kundklar', q.kundklar, 'avtalSlut', q.avtal_slut, 'projektstatus', q.projektstatus,
      'dorrar', coalesce(q.n, 0),
      'utfall', jsonb_build_object('s', coalesce(q.s, 0), 't', coalesce(q.t, 0), 'a', coalesce(q.a, 0),
          'r', coalesce(q.r, 0), 'x', coalesce(q.x, 0),
          'e', greatest(coalesce(q.n, q.lgh) - coalesce(q.s, 0) - coalesce(q.t, 0) - coalesce(q.a, 0) - coalesce(q.r, 0) - coalesce(q.x, 0), 0)),
      'vandor', coalesce(q.vandor, 0), 'senast', q.senast, 'uppskattad', coalesce(q.uppskattad, false),
      'saljbara', q.saljbara, 'faktor', (q.kv->>'faktor')::numeric, 'delar', q.kv->'delar',
      'effektiva', round(q.saljbara * (q.kv->>'faktor')::numeric))), '[]'::jsonb))
    into v_res
    from kval q;
  return v_res;
end $function$;
grant execute on function public.d2d_karta() to authenticated;
