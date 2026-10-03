-- =====================================================================
--  0054 — Telias lägenheter kopplas till leverans, koncernmoder och
--  direktägt bolag.
--
--  Koppling per fastighet (beteckning + ort) i Telias lista:
--   Leverans:  1) samma fastighetsbeteckning och ort/kommun,
--              2) samma beteckning när bara en leverans har den,
--              3) samma A-/KO-nr när bara en leverans har det.
--   Koncernmoder:   leveransens kund → kund på andra leveranser med samma
--                   A-/KO-nr → nätägarens namn → direktägt bolags koncern.
--   Direktägt bolag: leveransens direktägda bolag → nätägarens namn.
--  Körs efter varje import av adressbladet (telia_adresser_efter_import).
-- =====================================================================

alter table public.telia_adresser
  add column if not exists delivery_id uuid,
  add column if not exists koncernmoder_id uuid,
  add column if not exists direktagt_bolag_id uuid,
  add column if not exists kopplad_via text;
create index if not exists telia_adresser_delivery on public.telia_adresser (delivery_id);
create index if not exists telia_adresser_koncern on public.telia_adresser (koncernmoder_id);
create index if not exists telia_adresser_direktagt on public.telia_adresser (direktagt_bolag_id);

create or replace function public.telia_adresser_koppla()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g record; v_tenant uuid; v_lev uuid; v_km uuid; v_db uuid; v_via text; v_n int;
  v_lev_n int := 0; v_km_n int := 0; v_db_n int := 0; v_grupper int := 0;
  v_lev_data jsonb;   -- leveranserna, förberedda en gång
  km_id uuid[]; km_n text[]; db_id uuid[]; db_n text[]; db_km uuid[];
begin
  select id into v_tenant from tenants limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'bet', upper(btrim(coalesce(r.data->>'fastighetsbeteckning', ''))),
           'ort', r.data->>'ort', 'kommun', r.data->>'kommun',
           'ko', upper(btrim(coalesce(r.data->>'a_ko_nr', ''))),
           'avslutad', r.status = 'avslutad', 'skapad', r.created_at,
           'km', (select x.to_record_id from relationships x where x.from_record_id = r.id and x.rel_type = 'delivery_for' limit 1),
           'db', (select x.to_record_id from relationships x where x.from_record_id = r.id and x.rel_type = 'delivery_for_db' limit 1))), '[]'::jsonb)
    into v_lev_data
    from records r
   where r.object_type = 'delivery' and r.deleted_at is null and r.tenant_id = v_tenant;

  select array_agg(id), array_agg(norm_bolag(data->>'name')) into km_id, km_n
    from records where object_type = 'koncernmoder' and deleted_at is null and tenant_id = v_tenant
     and norm_bolag(data->>'name') is not null;
  select array_agg(r.id), array_agg(norm_bolag(r.data->>'name')),
         array_agg((select x.to_record_id from relationships x where x.from_record_id = r.id and x.rel_type = 'direktagt_av' limit 1))
    into db_id, db_n, db_km
    from records r where r.object_type = 'direktagt_bolag' and r.deleted_at is null and r.tenant_id = v_tenant
     and norm_bolag(r.data->>'name') is not null;

  for g in
    select fastighetsbeteckning bet, kommun, stad, upper(coalesce(avtalsnummer, '')) ko, natagare, norm_bolag(natagare) nag
      from telia_adresser where tenant_id = v_tenant
     group by fastighetsbeteckning, kommun, stad, upper(coalesce(avtalsnummer, '')), natagare
  loop
    v_grupper := v_grupper + 1;
    v_lev := null; v_km := null; v_db := null; v_via := null;

    select (l->>'id')::uuid into v_lev from jsonb_array_elements(v_lev_data) l
     where l->>'bet' = g.bet and coalesce(g.bet, '') <> ''
       and (samma_ort(l->>'ort', g.stad) or samma_ort(l->>'ort', g.kommun)
            or samma_ort(l->>'kommun', g.kommun) or samma_ort(l->>'kommun', g.stad))
     order by (l->>'avslutad')::boolean, l->>'skapad' limit 1;
    if v_lev is not null then v_via := 'beteckning+ort'; end if;

    if v_lev is null and coalesce(g.bet, '') <> '' then
      select count(*), min(l->>'id') into v_n, v_lev from jsonb_array_elements(v_lev_data) l where l->>'bet' = g.bet;
      if v_n = 1 then v_via := 'beteckning'; else v_lev := null; end if;
    end if;

    if v_lev is null and g.ko <> '' then
      select count(*), min(l->>'id') into v_n, v_lev from jsonb_array_elements(v_lev_data) l where l->>'ko' = g.ko;
      if v_n = 1 then v_via := 'ko-nr'; else v_lev := null; end if;
    end if;

    if v_lev is not null then
      select nullif(l->>'km', '')::uuid, nullif(l->>'db', '')::uuid into v_km, v_db
        from jsonb_array_elements(v_lev_data) l where (l->>'id')::uuid = v_lev;
    end if;

    if v_km is null and g.ko <> '' then
      select case when count(distinct l->>'km') = 1 then min(l->>'km')::uuid end into v_km
        from jsonb_array_elements(v_lev_data) l where l->>'ko' = g.ko and nullif(l->>'km', '') is not null;
    end if;
    if v_db is null and g.nag is not null then
      select t.id into v_db from unnest(db_id, db_n) as t(id, n) where t.n = g.nag limit 1;
    end if;
    if v_km is null and g.nag is not null then
      select t.id into v_km from unnest(km_id, km_n) as t(id, n) where t.n = g.nag limit 1;
    end if;
    if v_km is null and v_db is not null then
      select t.km into v_km from unnest(db_id, db_km) as t(id, km) where t.id = v_db;
    end if;

    update telia_adresser a
       set delivery_id = v_lev, koncernmoder_id = v_km, direktagt_bolag_id = v_db, kopplad_via = v_via
     where a.tenant_id = v_tenant and a.fastighetsbeteckning is not distinct from g.bet
       and a.kommun is not distinct from g.kommun and a.stad is not distinct from g.stad
       and upper(coalesce(a.avtalsnummer, '')) = g.ko and a.natagare is not distinct from g.natagare
       and (a.delivery_id, a.koncernmoder_id, a.direktagt_bolag_id, a.kopplad_via)
           is distinct from (v_lev, v_km, v_db, v_via);

    if v_lev is not null then v_lev_n := v_lev_n + 1; end if;
    if v_km is not null then v_km_n := v_km_n + 1; end if;
    if v_db is not null then v_db_n := v_db_n + 1; end if;
  end loop;

  return jsonb_build_object('fastigheter', v_grupper, 'med_leverans', v_lev_n,
    'med_koncernmoder', v_km_n, 'med_direktagt_bolag', v_db_n);
end $$;
revoke all on function public.telia_adresser_koppla() from public, anon, authenticated;
grant execute on function public.telia_adresser_koppla() to service_role;

-- Efter import: koppla först, fyll sedan på D2D-fastigheter som hämtat från Telia.
create or replace function public.telia_adresser_efter_import()
returns jsonb language plpgsql security definer set search_path = public as $$
declare f record; v_n int := 0; v_fast int := 0; v_koppling jsonb;
begin
  v_koppling := telia_adresser_koppla();
  for f in select id from records
            where object_type = 'd2d_fastighet' and deleted_at is null and data->>'telia_adresser' = 'true'
  loop
    v_n := v_n + d2d_fyll_lagenheter_fran_telia(f.id);
    v_fast := v_fast + 1;
  end loop;
  return jsonb_build_object('fastigheter', v_fast, 'nya_lagenheter', v_n, 'koppling', v_koppling);
end $$;
revoke all on function public.telia_adresser_efter_import() from public, anon, authenticated;
grant execute on function public.telia_adresser_efter_import() to service_role;

-- Lägenheterna för ett kort (leverans, koncernmoder eller direktägt bolag).
create or replace function public.telia_lagenheter_for(p_record_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'objektnummer', a.objektnummer, 'gata', a.gata, 'gatunummer', a.gatunummer, 'ingang', a.ingang,
           'lgh', a.lagenhetsnummer, 'postnummer', a.postnummer, 'ort', initcap(a.stad),
           'fastighet', coalesce(a.fastighetsbeteckning_telia, a.fastighetsbeteckning),
           'kategori', a.byggnadskategori, 'status', a.status, 'operator', a.kommunikationsoperator,
           'telia_bb', a.har_telia_bredband, 'delivery_id', a.delivery_id)
         order by a.fastighetsbeteckning, a.gata,
                  nullif(regexp_replace(coalesce(a.gatunummer, ''), '\D', '', 'g'), '')::int nulls last,
                  a.gatunummer, a.ingang, a.lagenhetsnummer), '[]'::jsonb)
    from telia_adresser a
   where a.tenant_id = my_tenant_id()
     and (a.delivery_id = p_record_id or a.koncernmoder_id = p_record_id or a.direktagt_bolag_id = p_record_id)
$$;
revoke all on function public.telia_lagenheter_for(uuid) from public, anon;
grant execute on function public.telia_lagenheter_for(uuid) to authenticated;
