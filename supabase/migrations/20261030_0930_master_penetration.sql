-- Master: Telias penetration per fastighet (filen "ConnectEstate penetration ÅÅMMDD.xlsx").
-- Gustav 30 okt: "per fastighet och per koncernmoder se vilken penetration vi lyckats få,
-- och ärvt ned i D2D Utfall per projekt". Alla fyra måtten visas likvärdigt, bara senaste
-- filen gäller (ny import ersätter den gamla), alla inloggade utom dörrsäljare ser talen.
--
-- Tabellen telia_penetration håller filens rader (en per fastighet och avtalsnummer) och
-- vilken leverans/fastighet/D2D-fastighet raden matchar. Efter import skrivs HC-viktade
-- värden som fält pen_* på leveransen (projektplanen), fastigheten i registret,
-- D2D-fastigheten, koncernmodern (alla dess fastigheter) och D2D-projektet.

create table if not exists public.telia_penetration (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  fastighet text not null,                 -- "KOMMUN BETECKNING", normaliserad
  avtalsnummer text,
  access_subtype text,
  kollektiv_iptv text,
  kollektiv_bb text,
  hc integer,                              -- hushåll (homes connected)
  bb_telia numeric, bb_tot numeric,        -- andelar 0–1 (null när filen har "-")
  iptv_telia numeric, iptv_tot numeric,
  matdatum date,
  delivery_id uuid, property_id uuid, d2d_fastighet_id uuid,
  aktuell boolean not null default true,       -- false = fanns inte i senaste filen
  importerad_at timestamptz not null default now()
);
alter table public.telia_penetration add column if not exists aktuell boolean not null default true;
-- Samma fastighet och avtalsnummer kan stå två gånger med olika accesstyp (Telia/Zitius ComOp).
create unique index if not exists telia_penetration_nyckel2
  on public.telia_penetration (tenant_id, fastighet, coalesce(avtalsnummer, ''), coalesce(access_subtype, ''));
create index if not exists telia_penetration_delivery on public.telia_penetration (delivery_id);
create index if not exists telia_penetration_property on public.telia_penetration (property_id);
create index if not exists telia_penetration_d2d on public.telia_penetration (d2d_fastighet_id);

alter table public.telia_penetration enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'telia_penetration' and policyname = 'telia_penetration_las') then
    create policy telia_penetration_las on public.telia_penetration for select to authenticated
      using (tenant_id = my_tenant_id() and (is_admin() or not d2d_ar_dorrsaljare(auth.uid())));
  end if;
end $$;
revoke all on public.telia_penetration from public, anon;
grant select on public.telia_penetration to authenticated;
grant all on public.telia_penetration to service_role;

-- "Borlänge  Plogen 1 " → "BORLÄNGE PLOGEN 1"
create or replace function public.penetration_norm(s text)
returns text language sql immutable as $$
  select nullif(upper(btrim(regexp_replace(coalesce(s, ''), '\s+', ' ', 'g'))), '')
$$;

-- Koppla raderna till leverans, fastighet och D2D-fastighet på kommun/ort + beteckning.
create or replace function public.penetration_koppla(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update telia_penetration t set
    delivery_id = (select d.id from records d where d.tenant_id = p_tenant and d.object_type = 'delivery' and d.deleted_at is null
      and (penetration_norm((d.data->>'kommun') || ' ' || (d.data->>'fastighetsbeteckning')) = t.fastighet
        or penetration_norm((d.data->>'ort') || ' ' || (d.data->>'fastighetsbeteckning')) = t.fastighet)
      order by (d.status = 'avslutad') limit 1),
    property_id = (select p.id from records p where p.tenant_id = p_tenant and p.object_type = 'property' and p.deleted_at is null
      and penetration_norm(p.data->>'fastighetsbeteckning_komplett') = t.fastighet limit 1)
  where t.tenant_id = p_tenant;

  update telia_penetration t set
    d2d_fastighet_id = coalesce(
      (select f.id from records f where f.tenant_id = p_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
        and (penetration_norm((f.data->>'kommun') || ' ' || (f.data->>'fastighetsbeteckning')) = t.fastighet
          or penetration_norm((f.data->>'ort') || ' ' || (f.data->>'fastighetsbeteckning')) = t.fastighet) limit 1),
      (select r.from_record_id from relationships r join records f on f.id = r.from_record_id and f.deleted_at is null
        where r.rel_type = 'd2d_fast_delivery' and r.to_record_id = t.delivery_id limit 1))
  where t.tenant_id = p_tenant;
end $$;
revoke all on function public.penetration_koppla(uuid) from public, anon, authenticated;

-- HC-viktat snitt per fastighet (flera avtalsnummer slås ihop). Andelar som procent med en decimal.
create or replace view public.penetration_per_fastighet as
  select tenant_id, fastighet, max(matdatum) as matdatum,
    max(delivery_id::text)::uuid as delivery_id, max(property_id::text)::uuid as property_id,
    max(d2d_fastighet_id::text)::uuid as d2d_fastighet_id,
    sum(hc) as hc,
    round(100 * sum(bb_telia * hc) / nullif(sum(hc) filter (where bb_telia is not null), 0), 1) as bb_telia,
    round(100 * sum(bb_tot * hc) / nullif(sum(hc) filter (where bb_tot is not null), 0), 1) as bb_tot,
    round(100 * sum(iptv_telia * hc) / nullif(sum(hc) filter (where iptv_telia is not null), 0), 1) as iptv_telia,
    round(100 * sum(iptv_tot * hc) / nullif(sum(hc) filter (where iptv_tot is not null), 0), 1) as iptv_tot
  from telia_penetration where aktuell group by tenant_id, fastighet;
revoke all on public.penetration_per_fastighet from public, anon;
grant select on public.penetration_per_fastighet to authenticated, service_role;

-- Vilka fastigheter (rader i vyn) hör till en post: leveransen/fastigheten/D2D-fastigheten
-- själv, koncernmoderns alla (via leverans, fastighet och direktägt bolag) eller D2D-projektets.
create or replace function public.penetration_fastigheter_for(p_id uuid)
returns setof public.penetration_per_fastighet
language sql stable security definer set search_path = public as $$
  with post as (select r.id, r.tenant_id, r.object_type from records r where r.id = p_id and r.deleted_at is null),
  mal as (
    select p.id as rid from post p where p.object_type in ('delivery', 'property', 'd2d_fastighet')
    union
    select r.from_record_id from post p join relationships r on r.to_record_id = p.id
      where p.object_type = 'koncernmoder' and r.rel_type in ('delivery_for', 'property_of')
    union
    select r2.from_record_id from post p
      join relationships r on r.to_record_id = p.id and r.rel_type = 'direktagt_av'
      join relationships r2 on r2.to_record_id = r.from_record_id and r2.rel_type in ('delivery_for_db', 'property_of_db')
      where p.object_type = 'koncernmoder'
    union
    select r.from_record_id from post p join relationships r on r.to_record_id = p.id
      where p.object_type = 'd2d_projekt' and r.rel_type = 'd2d_fast_projekt'
    union
    select r2.to_record_id from post p
      join relationships r on r.to_record_id = p.id and r.rel_type = 'd2d_fast_projekt'
      join relationships r2 on r2.from_record_id = r.from_record_id and r2.rel_type = 'd2d_fast_delivery'
      where p.object_type = 'd2d_projekt')
  select v.* from penetration_per_fastighet v, post p
   where v.tenant_id = p.tenant_id
     and (v.delivery_id in (select rid from mal) or v.property_id in (select rid from mal) or v.d2d_fastighet_id in (select rid from mal))
$$;
revoke all on function public.penetration_fastigheter_for(uuid) from public, anon, authenticated;

-- Summering (HC-viktad) av ett antal fastighetsrader.
create or replace function public.penetration_summa(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'fastigheter', count(*), 'hc', coalesce(sum(hc), 0), 'matdatum', max(matdatum),
    'bb_telia', round(sum(bb_telia * hc) / nullif(sum(hc) filter (where bb_telia is not null), 0), 1),
    'bb_tot', round(sum(bb_tot * hc) / nullif(sum(hc) filter (where bb_tot is not null), 0), 1),
    'iptv_telia', round(sum(iptv_telia * hc) / nullif(sum(hc) filter (where iptv_telia is not null), 0), 1),
    'iptv_tot', round(sum(iptv_tot * hc) / nullif(sum(hc) filter (where iptv_tot is not null), 0), 1))
  from penetration_fastigheter_for(p_id)
$$;
revoke all on function public.penetration_summa(uuid) from public, anon, authenticated;

-- Skriv fälten pen_* på alla berörda poster (och ta bort dem där underlaget försvunnit).
create or replace function public.penetration_skriv_falt(p_tenant uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; v_m integer;
begin
  -- Fastighetsnivå: leverans, fastighet, D2D-fastighet.
  with ids as (
    select delivery_id as id from penetration_per_fastighet where tenant_id = p_tenant and delivery_id is not null
    union select property_id from penetration_per_fastighet where tenant_id = p_tenant and property_id is not null
    union select d2d_fastighet_id from penetration_per_fastighet where tenant_id = p_tenant and d2d_fastighet_id is not null
    union select r.id from records r where r.tenant_id = p_tenant and r.deleted_at is null
      and r.object_type in ('delivery', 'property', 'd2d_fastighet', 'koncernmoder', 'd2d_projekt') and r.data ? 'pen_datum'
    union select r.to_record_id from relationships r join penetration_per_fastighet v on v.delivery_id = r.from_record_id
      where v.tenant_id = p_tenant and r.rel_type in ('delivery_for', 'delivery_for_db')
    union select r.to_record_id from relationships r join penetration_per_fastighet v on v.property_id = r.from_record_id
      where v.tenant_id = p_tenant and r.rel_type in ('property_of', 'property_of_db')
    union select r.to_record_id from relationships r join penetration_per_fastighet v on v.d2d_fastighet_id = r.from_record_id
      where v.tenant_id = p_tenant and r.rel_type = 'd2d_fast_projekt'),
  -- direktägt bolag → koncernmoder
  ids2 as (
    select id from ids
    union select r.to_record_id from relationships r join ids i on i.id = r.from_record_id where r.rel_type = 'direktagt_av'),
  ny as (
    select r.id, r.data, r.object_type, penetration_summa(r.id) as s from records r join ids2 i on i.id = r.id
     where r.deleted_at is null and r.object_type in ('delivery', 'property', 'd2d_fastighet', 'koncernmoder', 'd2d_projekt')),
  nytt as (
    select id, data,
      (data - array['pen_hc', 'pen_bb_telia', 'pen_bb_tot', 'pen_iptv_telia', 'pen_iptv_tot', 'pen_datum', 'pen_fastigheter'])
        || case when (s->>'fastigheter')::int > 0 then jsonb_strip_nulls(jsonb_build_object(
             'pen_hc', s->'hc', 'pen_bb_telia', s->'bb_telia', 'pen_bb_tot', s->'bb_tot',
             'pen_iptv_telia', s->'iptv_telia', 'pen_iptv_tot', s->'iptv_tot', 'pen_datum', s->'matdatum',
             'pen_fastigheter', case when object_type in ('koncernmoder', 'd2d_projekt') then s->'fastigheter' end))
           else '{}'::jsonb end as d
    from ny),
  u as (
    update records r set data = nytt.d, updated_at = now()
    from nytt where r.id = nytt.id and nytt.data is distinct from nytt.d
    returning 1)
  select count(*) into v_m from u;
  v_n := v_n + coalesce(v_m, 0);
  return v_n;
end $$;
revoke all on function public.penetration_skriv_falt(uuid) from public, anon, authenticated;

-- "0.0568", "5,7 %", "114%" eller "-" → andel 0–1 (null när det inte är ett tal).
create or replace function public.penetration_tal(s text)
returns numeric language plpgsql immutable as $$
declare v text := replace(replace(btrim(coalesce(s, '')), ',', '.'), ' ', ''); x numeric;
begin
  if v = '' or v = '-' then return null; end if;
  if right(v, 1) = '%' then
    v := left(v, length(v) - 1);
    if v !~ '^-?\d+(\.\d+)?$' then return null; end if;
    return v::numeric / 100;
  end if;
  if v !~ '^-?\d+(\.\d+)?([eE]-?\d+)?$' then return null; end if;
  x := v::numeric;
  return x;
end $$;

-- Importen (Inställningar → Import). p_rows = filens rader som objekt med filens rubriker.
-- Hela filen i ett anrop: en ny fil ersätter den gamla (bara senaste värdet gäller, rader som
-- försvunnit ur filen märks aktuell = false).
create or replace function public.import_telia_penetration(p_rows jsonb, p_dry_run boolean default true, p_datum date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_tot int; v_n int; v_match int; v_hc int; v_falt int := 0;
  v_deliv int; v_prop int; v_d2d int; v_ingen int;
begin
  if not is_admin() then
    raise exception 'Åtkomst nekad — admin krävs för import.' using errcode = '42501';
  end if;

  -- Rader utan fastighetsbeteckning hoppas över; samma fastighet, avtalsnummer och
  -- accesstyp två gånger → raden med flest hushåll gäller.
  create temp table pen_in on commit drop as
    select distinct on (fastighet, coalesce(avtalsnummer, ''), coalesce(access_subtype, '')) *
      from (select penetration_norm(r->>'nf_property_designation') as fastighet,
              nullif(btrim(r->>'NF_Agreement_Number'), '') as avtalsnummer,
              nullif(btrim(r->>'AccessSubType'), '') as access_subtype,
              nullif(nullif(btrim(r->>'Siebel_CollIPTV'), ''), '-') as kollektiv_iptv,
              nullif(nullif(btrim(r->>'Siebel_CollBB'), ''), '-') as kollektiv_bb,
              case when (r->>'HC') ~ '^\d+(\.0+)?$' then (r->>'HC')::numeric::int end as hc,
              penetration_tal(r->>'BB Telia Pen %') as bb_telia,
              penetration_tal(r->>'BB TOT Pen %') as bb_tot,
              penetration_tal(r->>'IPTV Telia Ind Pen %') as iptv_telia,
              penetration_tal(r->>'IPTV Tot Pen %') as iptv_tot
            from jsonb_array_elements(p_rows) r) x
     where fastighet is not null
     order by fastighet, coalesce(avtalsnummer, ''), coalesce(access_subtype, ''), hc desc nulls last;
  select jsonb_array_length(p_rows) into v_tot;
  select count(*), coalesce(sum(hc), 0) into v_n, v_hc from pen_in;

  -- Matchning (torrkörning räknar på samma sätt som den riktiga).
  with m as (
    select i.fastighet,
      exists (select 1 from records d where d.tenant_id = v_t and d.object_type = 'delivery' and d.deleted_at is null
        and (penetration_norm((d.data->>'kommun') || ' ' || (d.data->>'fastighetsbeteckning')) = i.fastighet
          or penetration_norm((d.data->>'ort') || ' ' || (d.data->>'fastighetsbeteckning')) = i.fastighet)) as deliv,
      exists (select 1 from records p where p.tenant_id = v_t and p.object_type = 'property' and p.deleted_at is null
        and penetration_norm(p.data->>'fastighetsbeteckning_komplett') = i.fastighet) as prop,
      exists (select 1 from records f where f.tenant_id = v_t and f.object_type = 'd2d_fastighet' and f.deleted_at is null
        and (penetration_norm((f.data->>'kommun') || ' ' || (f.data->>'fastighetsbeteckning')) = i.fastighet
          or penetration_norm((f.data->>'ort') || ' ' || (f.data->>'fastighetsbeteckning')) = i.fastighet)) as d2d
    from (select distinct fastighet from pen_in) i)
  select count(*) filter (where deliv), count(*) filter (where prop), count(*) filter (where d2d),
         count(*) filter (where not deliv and not prop and not d2d), count(*)
    into v_deliv, v_prop, v_d2d, v_ingen, v_match from m;

  if not p_dry_run then
    -- Ny fil ersätter den gamla: filens rader skrivs in (eller uppdateras), rader som
    -- inte finns i filen märks som inaktuella.
    insert into telia_penetration (tenant_id, fastighet, avtalsnummer, access_subtype, kollektiv_iptv, kollektiv_bb,
                                   hc, bb_telia, bb_tot, iptv_telia, iptv_tot, matdatum, aktuell, importerad_at)
      select v_t, fastighet, avtalsnummer, access_subtype, kollektiv_iptv, kollektiv_bb,
             hc, bb_telia, bb_tot, iptv_telia, iptv_tot, coalesce(p_datum, current_date), true, now()
        from pen_in
    on conflict (tenant_id, fastighet, coalesce(avtalsnummer, ''), coalesce(access_subtype, '')) do update set
      kollektiv_iptv = excluded.kollektiv_iptv, kollektiv_bb = excluded.kollektiv_bb,
      hc = excluded.hc, bb_telia = excluded.bb_telia, bb_tot = excluded.bb_tot, iptv_telia = excluded.iptv_telia,
      iptv_tot = excluded.iptv_tot, matdatum = excluded.matdatum, aktuell = true, importerad_at = excluded.importerad_at;
    -- now() är transaktionens start, så filens rader har exakt now() och äldre rader ligger före.
    update telia_penetration set aktuell = false where tenant_id = v_t and aktuell and importerad_at < now();
    perform penetration_koppla(v_t);
    v_falt := penetration_skriv_falt(v_t);
  end if;

  return jsonb_build_object('nya', v_n, 'uppdaterade', 0, 'hoppade', v_tot - v_n, 'slangda_varden', 0,
    'statusbyten', 0, 'kopplade_kunder', 0, 'torrkorning', p_dry_run,
    'fastigheter', v_match, 'hushall', v_hc, 'leveranser', v_deliv, 'fastighetsregister', v_prop,
    'd2d_fastigheter', v_d2d, 'omatchade', v_ingen, 'poster_uppdaterade', v_falt, 'matdatum', coalesce(p_datum, current_date));
end $$;
revoke all on function public.import_telia_penetration(jsonb, boolean, date) from public, anon;
grant execute on function public.import_telia_penetration(jsonb, boolean, date) to authenticated, service_role;

-- Vad en post har: summan och raderna per fastighet (koncernmoderns flik, Utfall).
create or replace function public.penetration_for_post(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid;
begin
  select tenant_id into v_t from records where id = p_id and deleted_at is null;
  if v_t is null or v_t <> my_tenant_id() or (d2d_ar_dorrsaljare(auth.uid()) and not is_admin()) then
    return jsonb_build_object('summa', null, 'rader', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'summa', penetration_summa(p_id),
    'rader', coalesce((select jsonb_agg(jsonb_build_object(
        'fastighet', v.fastighet, 'hc', v.hc, 'bb_telia', v.bb_telia, 'bb_tot', v.bb_tot,
        'iptv_telia', v.iptv_telia, 'iptv_tot', v.iptv_tot, 'matdatum', v.matdatum,
        'delivery_id', v.delivery_id, 'property_id', v.property_id, 'd2d_fastighet_id', v.d2d_fastighet_id,
        'koncernmoder', (select k.title from relationships r join records k on k.id = r.to_record_id
                          where r.rel_type = 'delivery_for' and r.from_record_id = v.delivery_id limit 1),
        'avtal', (select jsonb_agg(jsonb_build_object('avtalsnummer', t.avtalsnummer, 'typ', t.access_subtype,
                     'kollektiv_iptv', t.kollektiv_iptv, 'kollektiv_bb', t.kollektiv_bb, 'hc', t.hc) order by t.hc desc nulls last)
                   from telia_penetration t where t.tenant_id = v.tenant_id and t.fastighet = v.fastighet and t.aktuell))
        order by v.hc desc nulls last, v.fastighet)
      from penetration_fastigheter_for(p_id) v), '[]'::jsonb));
end $$;
revoke all on function public.penetration_for_post(uuid) from public, anon;
grant execute on function public.penetration_for_post(uuid) to authenticated, service_role;

-- Utfall: alla D2D-projekt med sin penetration (och totalen).
create or replace function public.d2d_penetration_projekt()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id();
begin
  if v_t is null or (d2d_ar_dorrsaljare(auth.uid()) and not is_admin()) then
    return jsonb_build_object('projekt', '[]'::jsonb, 'totalt', null, 'matdatum', null);
  end if;
  return jsonb_build_object(
    'matdatum', (select max(matdatum) from telia_penetration where tenant_id = v_t and aktuell),
    'projekt', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status) || penetration_summa(p.id)
                          order by p.title)
      from records p where p.tenant_id = v_t and p.object_type = 'd2d_projekt' and p.deleted_at is null), '[]'::jsonb),
    'totalt', (select jsonb_build_object(
        'fastigheter', count(*), 'hc', coalesce(sum(v.hc), 0),
        'bb_telia', round(sum(v.bb_telia * v.hc) / nullif(sum(v.hc) filter (where v.bb_telia is not null), 0), 1),
        'bb_tot', round(sum(v.bb_tot * v.hc) / nullif(sum(v.hc) filter (where v.bb_tot is not null), 0), 1),
        'iptv_telia', round(sum(v.iptv_telia * v.hc) / nullif(sum(v.hc) filter (where v.iptv_telia is not null), 0), 1),
        'iptv_tot', round(sum(v.iptv_tot * v.hc) / nullif(sum(v.hc) filter (where v.iptv_tot is not null), 0), 1))
      from penetration_per_fastighet v where v.tenant_id = v_t
        and (v.d2d_fastighet_id in (select r.from_record_id from relationships r where r.rel_type = 'd2d_fast_projekt')
          or v.delivery_id in (select r2.to_record_id from relationships r join relationships r2 on r2.from_record_id = r.from_record_id
                                where r.rel_type = 'd2d_fast_projekt' and r2.rel_type = 'd2d_fast_delivery'))));
end $$;
revoke all on function public.d2d_penetration_projekt() from public, anon;
grant execute on function public.d2d_penetration_projekt() to authenticated, service_role;

-- Fälten pen_* (sektion "penetration") på de fem objekttyperna.
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, f.key, f.label, f.typ, false,
       jsonb_build_object('section', 'penetration', '_column', f.kol, '_column_order', 900 + f.ordn)
         || case when f.typ = 'number' then '{"decimals":0}'::jsonb else '{}'::jsonb end,
       1900 + f.ordn
  from object_definitions od
  cross join (values
    ('pen_hc', 'Hushåll (Telia HC)', 'number', false, 1),
    ('pen_bb_telia', 'Penetration BB Telia', 'percent', true, 2),
    ('pen_bb_tot', 'Penetration BB totalt', 'percent', true, 3),
    ('pen_iptv_telia', 'Penetration IPTV Telia', 'percent', false, 4),
    ('pen_iptv_tot', 'Penetration IPTV totalt', 'percent', false, 5),
    ('pen_fastigheter', 'Fastigheter med penetration', 'number', false, 6),
    ('pen_datum', 'Penetration mätdatum', 'date', false, 7)) as f(key, label, typ, kol, ordn)
 where od.key in ('delivery', 'property', 'd2d_fastighet', 'koncernmoder', 'd2d_projekt')
   and (f.key <> 'pen_fastigheter' or od.key in ('koncernmoder', 'd2d_projekt'))
   and not exists (select 1 from field_definitions x where x.object_id = od.id and x.key = f.key);
update field_definitions set help_text = 'Fylls av importen av Telias penetrationsfil (Inställningar → Import). HC-viktat snitt över fastigheterna.'
 where key like 'pen\_%' and help_text is null;
