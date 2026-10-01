-- Door to door → Lägenheter:
--  1) Byte av säljare på en lägenhet slår igenom överallt: ägaren (som styr
--     vad säljaren ser i D2D-vyn) följer fältet Säljare, och fastighetens
--     tilldelning i projektbyggaren hålls i takt.
--  2) Lägenhetslistan kan filtreras på projekt (lägenhet → fastighet →
--     projekt) via systemfiltret "__related".
--  3) Översikt per projekt med antal per status (d2d_lagenhet_oversikt).
--  4) Säljare blir listans ägarfält → markera flera och byt säljare.

-- 1a) Säljare → ägare (före skrivning).
create or replace function public.d2d_lag_saljare_till_agare()
returns trigger language plpgsql set search_path = public as $$
declare v_s text := nullif(btrim(coalesce(new.data->>'saljare', '')), '');
begin
  if tg_op = 'UPDATE' and (new.data->>'saljare') is not distinct from (old.data->>'saljare') then
    return new;
  end if;
  if v_s is null then
    -- Säljaren togs bort: adressen försvinner från säljarens D2D-vy.
    if tg_op = 'UPDATE' then new.owner_user_id := null; end if;
  elsif v_s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    new.owner_user_id := v_s::uuid;
  end if;
  return new;
end $$;

create or replace trigger trg_d2d_lag_saljare_till_agare
  before insert or update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_lag_saljare_till_agare();

-- 1b) Fastighetens tilldelning följer med (efter skrivning). Bara när
--     fastigheten redan har adressvis tilldelning eller projektet är
--     godkänt — ett ej godkänt projekt med procentfördelning lämnas orört.
create or replace function public.d2d_lag_saljare_till_fastighet()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_f record; v_s text := nullif(btrim(coalesce(new.data->>'saljare', '')), ''); v_manuell jsonb; v_summa jsonb;
begin
  if (new.data->>'saljare') is not distinct from (old.data->>'saljare') then return new; end if;
  for v_f in
    select f.id, f.data
      from relationships rl join records f on f.id = rl.to_record_id
     where rl.from_record_id = new.id and rl.rel_type = 'd2d_lag_fastighet' and f.deleted_at is null
  loop
    if not (jsonb_typeof(v_f.data->'manuell_tilldelning') = 'object'
            or exists (select 1 from relationships e join records p on p.id = e.to_record_id
                        where e.from_record_id = v_f.id and e.rel_type = 'd2d_fast_projekt'
                          and p.status = 'godkant' and p.deleted_at is null)) then
      continue;
    end if;
    if jsonb_typeof(v_f.data->'manuell_tilldelning') = 'object' then
      v_manuell := (v_f.data->'manuell_tilldelning') - new.id::text;
      if v_s is not null then v_manuell := v_manuell || jsonb_build_object(new.id::text, v_s); end if;
    else
      -- Första adressvisa ändringen: utgå från hur alla adresser är fördelade nu.
      select coalesce(jsonb_object_agg(l.id::text, l.data->>'saljare'), '{}'::jsonb) into v_manuell
        from relationships rl join records l on l.id = rl.from_record_id
       where rl.to_record_id = v_f.id and rl.rel_type = 'd2d_lag_fastighet'
         and l.deleted_at is null and nullif(l.data->>'saljare', '') is not null;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('user_id', s, 'antal', n,
             'procent', round(n * 100.0 / greatest(tot, 1))) order by n desc), '[]'::jsonb)
      into v_summa
      from (select l.data->>'saljare' s, count(*) n, sum(count(*)) over () tot
              from relationships rl join records l on l.id = rl.from_record_id
             where rl.to_record_id = v_f.id and rl.rel_type = 'd2d_lag_fastighet'
               and l.deleted_at is null and nullif(l.data->>'saljare', '') is not null
             group by 1) x;

    if v_f.data->'manuell_tilldelning' is distinct from v_manuell
       or v_f.data->'saljartilldelning' is distinct from v_summa then
      update records set data = data || jsonb_build_object('manuell_tilldelning', v_manuell, 'saljartilldelning', v_summa)
       where id = v_f.id;
    end if;
  end loop;
  return new;
end $$;

create or replace trigger trg_d2d_lag_saljare_till_fastighet
  after update of data on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_lag_saljare_till_fastighet();

-- Rätta befintliga rader där ägaren inte följer säljaren.
update records set owner_user_id = (data->>'saljare')::uuid
 where object_type = 'd2d_lagenhet' and deleted_at is null
   and (data->>'saljare') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and owner_user_id is distinct from (data->>'saljare')::uuid;

-- 4) Säljare = ägarfält i listan (markera och byt säljare, snabbfilter).
update field_definitions fd set options = fd.options || '{"owner_field": true}'::jsonb
  from object_definitions od
 where od.id = fd.object_id and od.key = 'd2d_lagenhet' and fd.key = 'saljare';

-- 3) Översikt per projekt.
create or replace function public.d2d_lagenhet_oversikt()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_scope text; v jsonb;
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v_scope := public.my_scope('d2d_lagenhet', 'read');

  with lag as (
    select distinct on (l.id) l.id, l.status, nullif(l.data->>'saljare', '') saljare,
           rp.to_record_id projekt_id, rf.to_record_id fastighet_id
      from records l
      left join relationships rf on rf.from_record_id = l.id and rf.rel_type = 'd2d_lag_fastighet'
      left join relationships rp on rp.from_record_id = rf.to_record_id and rp.rel_type = 'd2d_fast_projekt'
     where l.tenant_id = my_tenant_id() and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and public.in_scope(v_scope, l.owner_user_id)
  ),
  per_projekt as (
    select projekt_id, count(*) total, count(distinct fastighet_id) fastigheter,
           count(*) filter (where saljare is null) utan_saljare,
           (select jsonb_object_agg(s, n) from (select status s, count(*) n from lag l2
              where l2.projekt_id is not distinct from lag.projekt_id group by 1) z) statusar,
           (select jsonb_agg(jsonb_build_object('id', s, 'antal', n) order by n desc) from (select saljare s, count(*) n from lag l3
              where l3.projekt_id is not distinct from lag.projekt_id and l3.saljare is not null group by 1) z) saljare
      from lag group by projekt_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pp.projekt_id, 'title', coalesce(p.title, 'Utan projekt'), 'projektStatus', p.status,
           'total', pp.total, 'fastigheter', pp.fastigheter, 'utanSaljare', pp.utan_saljare,
           'statusar', coalesce(pp.statusar, '{}'::jsonb), 'saljare', coalesce(pp.saljare, '[]'::jsonb),
           'skapad', p.created_at)
         order by (pp.projekt_id is null), p.created_at desc nulls last), '[]'::jsonb)
    into v
    from per_projekt pp left join records p on p.id = pp.projekt_id;
  return v;
end $$;
grant execute on function public.d2d_lagenhet_oversikt() to authenticated;

-- 2) Systemfiltret "__related": posten är kopplad till en viss post, direkt
--    eller via en mellanliggande post (lägenhet → fastighet → projekt).
--    Läggs in i list_records_filtered utan att resten av funktionen ändras.
do $mig$
declare d text; anchor text := '    -- Bara fält som finns i metadata, plus de fyra systemkolumnerna';
begin
  d := pg_get_functiondef('public.list_records_filtered'::regproc);
  if position('__related' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'list_records_filtered: hittar inte insättningspunkten'; end if;
  d := replace(d, anchor,
$ins$    -- Kopplad till en viss post (direkt eller via en mellanliggande post),
    -- t.ex. lägenheterna i ett D2D-projekt.
    if v_falt = '__related' then
      if (v_v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_villkor := v_villkor || format(
          '(r.id in (select rl.from_record_id from relationships rl where rl.to_record_id = %1$L::uuid'
          ' union select rl1.from_record_id from relationships rl1'
          ' join relationships rl2 on rl2.from_record_id = rl1.to_record_id where rl2.to_record_id = %1$L::uuid))',
          v_v #>> '{}');
      end if;
      continue;
    end if;

$ins$ || anchor);
  execute d;
end $mig$;
