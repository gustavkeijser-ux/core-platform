-- =====================================================================
--  0053 — Telias adresslista (bladet "Utdrag app Leveransvolymer") som
--  underlag för D2D.
--
--  1. telia_adresser: en rad per lägenhet/anslutningspunkt (~18 000),
--     uppdateras vid varje import av Projektplan CE.xlsx (bladet Adresser).
--  2. d2d_fyll_lagenheter_fran_telia(): skapar D2D-lägenheter för en
--     D2D-fastighet utifrån Telias lista. Körs när en fastighet läggs till
--     i ett D2D-projekt, med knappen "Hämta lägenheter från Telia", och
--     efter varje import (nya adresser till fastigheter som redan hämtat).
--     Befintliga lägenheter dubbleras inte: de känns igen på Telias
--     objektnummer, PunktID eller gata + nummer + lägenhetsnummer.
--     Bara bostäder (MDU/SDU) som inte är inaktiva tas med.
-- =====================================================================

create table if not exists public.telia_adresser (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  objektnummer text not null,
  punkt_id text,
  status text,
  gata text,
  gatunummer text,
  lagenhetsnummer text,
  ingang text,
  postnummer text,
  stad text,
  kommun text,
  fastighetsbeteckning text,          -- "enhetlig", versaler
  fastighetsbeteckning_telia text,    -- som Telia skriver den
  byggnadskategori text,
  kommunikationsoperator text,
  natagare text,
  avtalsnummer text,
  cpe_modell text,
  cpe_status text,
  har_telia_bredband boolean,
  avslutat_projekt boolean,
  senast_sedd timestamptz not null default now(),
  primary key (tenant_id, objektnummer)
);
create index if not exists telia_adresser_fastighet on public.telia_adresser (tenant_id, fastighetsbeteckning);
alter table public.telia_adresser enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'telia_adresser' and policyname = 'telia_adresser_las') then
    create policy telia_adresser_las on public.telia_adresser for select to authenticated
      using (tenant_id = my_tenant_id());
  end if;
end $$;

-- Nya fält på D2D-lägenheten
do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'd2d_lagenhet';
    if v_obj is null then continue; end if;
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select v_obj, t.id, f.key, f.label, f.typ, false, f.opt::jsonb, f.sort
      from (values
        ('har_telia_bredband', 'Har Telia Bredband (enl. Telia)', 'boolean', '{"section":"adress"}', 9010),
        ('telia_status',       'Status hos Telia',                'text',    '{"section":"adress"}', 9020),
        ('telia_objektnummer', 'Telias objektnummer',             'text',    '{"section":"adress"}', 9030)
      ) as f(key, label, typ, opt, sort)
     where not exists (select 1 from field_definitions x where x.object_id = v_obj and x.key = f.key);
  end loop;
end $$;

-- ── Import ───────────────────────────────────────────────────────────

create or replace function public.telia_txt(p text)
returns text language sql immutable as $$
  select case when btrim(coalesce(p, '')) in ('', '-', '#N/A', '#REF!', '0') then null else btrim(p) end
$$;

-- En rad per objektnummer ur bladets rader (rubrikerna som nycklar).
create or replace function public.telia_rader_ur_json(p_rows jsonb, p_tenant uuid)
returns setof public.telia_adresser language sql stable as $$
  select distinct on (telia_txt(r->>'Objektnummer'))
         p_tenant, telia_txt(r->>'Objektnummer'), telia_txt(r->>'Punkt ID'), telia_txt(r->>'Status'),
         telia_txt(r->>'Gata'), telia_txt(r->>'Gatunummer'), telia_txt(r->>'Lägenhetsnummer'), telia_txt(r->>'Ingång'),
         replace(telia_txt(r->>'Postnummer'), ' ', ''), telia_txt(r->>'Stad'), telia_txt(r->>'Kommun'),
         upper(coalesce(telia_txt(r->>'Fastighetsbeteckning enhetlig'), telia_txt(r->>'Fastighetsbeteckning'))),
         telia_txt(r->>'Fastighetsbeteckning'), telia_txt(r->>'Byggnadskategori'),
         telia_txt(r->>'Kommunikationsoperatör'), telia_txt(r->>'Nätägare'), telia_txt(r->>'Avtalsnummer'),
         telia_txt(r->>'CPE-modell'), telia_txt(r->>'CPE-status'),
         case upper(btrim(coalesce(r->>'Har Telia Bredband', ''))) when 'JA' then true when 'NEJ' then false end,
         case btrim(coalesce(r->>'Är flyttad till Avslutade projekt', '')) when '1' then true when '0' then false end,
         now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where telia_txt(r->>'Objektnummer') is not null
$$;

create or replace function public.ingest_telia_adresser(p_rows jsonb, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_ny int; v_upp int; v_n int; v_tot int;
begin
  select id into v_tenant from public.tenants limit 1;
  v_tot := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  select count(*), count(*) filter (where a.objektnummer is null),
         count(*) filter (where a.objektnummer is not null and
           (a.punkt_id, a.status, a.gata, a.gatunummer, a.lagenhetsnummer, a.ingang, a.postnummer, a.stad, a.kommun,
            a.fastighetsbeteckning, a.byggnadskategori, a.kommunikationsoperator, a.natagare, a.avtalsnummer,
            a.cpe_modell, a.cpe_status, a.har_telia_bredband, a.avslutat_projekt)
           is distinct from
           (n.punkt_id, n.status, n.gata, n.gatunummer, n.lagenhetsnummer, n.ingang, n.postnummer, n.stad, n.kommun,
            n.fastighetsbeteckning, n.byggnadskategori, n.kommunikationsoperator, n.natagare, n.avtalsnummer,
            n.cpe_modell, n.cpe_status, n.har_telia_bredband, n.avslutat_projekt))
    into v_n, v_ny, v_upp
    from telia_rader_ur_json(p_rows, v_tenant) n
    left join telia_adresser a on a.tenant_id = n.tenant_id and a.objektnummer = n.objektnummer;

  if not p_dry_run then
    insert into telia_adresser select * from telia_rader_ur_json(p_rows, v_tenant)
    on conflict (tenant_id, objektnummer) do update set
      punkt_id = excluded.punkt_id, status = excluded.status, gata = excluded.gata, gatunummer = excluded.gatunummer,
      lagenhetsnummer = excluded.lagenhetsnummer, ingang = excluded.ingang, postnummer = excluded.postnummer,
      stad = excluded.stad, kommun = excluded.kommun, fastighetsbeteckning = excluded.fastighetsbeteckning,
      fastighetsbeteckning_telia = excluded.fastighetsbeteckning_telia, byggnadskategori = excluded.byggnadskategori,
      kommunikationsoperator = excluded.kommunikationsoperator, natagare = excluded.natagare,
      avtalsnummer = excluded.avtalsnummer, cpe_modell = excluded.cpe_modell, cpe_status = excluded.cpe_status,
      har_telia_bredband = excluded.har_telia_bredband, avslutat_projekt = excluded.avslutat_projekt,
      senast_sedd = excluded.senast_sedd;
  end if;

  return jsonb_build_object('nya', v_ny, 'uppdaterade', v_upp, 'hoppade', v_tot - v_n,
    'slangda_varden', 0, 'statusbyten', 0, 'kopplade_kunder', 0, 'torrkorning', p_dry_run);
end $$;
revoke all on function public.ingest_telia_adresser(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.ingest_telia_adresser(jsonb, boolean) to service_role;

create or replace function public.import_telia_adresser(p_rows jsonb, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Åtkomst nekad — admin krävs för import.' using errcode = '42501';
  end if;
  return public.ingest_telia_adresser(p_rows, p_dry_run);
end $$;
revoke all on function public.import_telia_adresser(jsonb, boolean) from public, anon;
grant execute on function public.import_telia_adresser(jsonb, boolean) to authenticated, service_role;

-- ── Lägenheter till D2D ──────────────────────────────────────────────

-- Telias rader för en D2D-fastighet. Samma beteckning finns ofta i flera
-- kommuner ("LINDEN 14"), så finns fler än en kommun krävs att ort,
-- kommun eller postnummer stämmer.
create or replace function public.d2d_telia_rader(p_fastighet_id uuid)
returns setof public.telia_adresser
language plpgsql stable security definer set search_path = public as $$
declare f record; v_bet text; v_kommuner int;
begin
  select r.tenant_id, r.data into f from records r
   where r.id = p_fastighet_id and r.object_type = 'd2d_fastighet' and r.deleted_at is null;
  if not found then return; end if;
  v_bet := upper(btrim(coalesce(f.data->>'fastighetsbeteckning', '')));
  if v_bet = '' then return; end if;

  select count(distinct coalesce(kommun, stad)) into v_kommuner
    from telia_adresser where tenant_id = f.tenant_id and fastighetsbeteckning = v_bet;

  return query
    select a.* from telia_adresser a
     where a.tenant_id = f.tenant_id and a.fastighetsbeteckning = v_bet
       and coalesce(a.byggnadskategori, 'MDU') in ('MDU', 'SDU')
       and coalesce(a.status, '') <> 'Inactive'
       and (v_kommuner <= 1
            or samma_ort(a.kommun, f.data->>'kommun') or samma_ort(a.stad, f.data->>'ort')
            or samma_ort(a.kommun, f.data->>'ort') or samma_ort(a.stad, f.data->>'kommun')
            or (a.postnummer is not null and a.postnummer = replace(coalesce(f.data->>'postnummer', ''), ' ', '')));
end $$;
revoke all on function public.d2d_telia_rader(uuid) from public, anon, authenticated;

create or replace function public.d2d_fyll_lagenheter_fran_telia(p_fastighet_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare f record; a record; v_id uuid; v_n int := 0;
begin
  select r.id, r.tenant_id, r.owner_user_id into f from records r
   where r.id = p_fastighet_id and r.object_type = 'd2d_fastighet' and r.deleted_at is null;
  if not found then return 0; end if;

  for a in
    select t.* from d2d_telia_rader(p_fastighet_id) t
     where not exists (
       select 1 from relationships rl join records l on l.id = rl.from_record_id and l.deleted_at is null
        where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = f.id
          and (l.data->>'telia_objektnummer' = t.objektnummer
               or (t.punkt_id is not null and l.data->>'punkt_id' = t.punkt_id)
               or (upper(btrim(coalesce(l.data->>'gatunamn', ''))) = upper(coalesce(t.gata, ''))
                   and upper(btrim(coalesce(l.data->>'gatunummer', ''))) = upper(coalesce(t.gatunummer, ''))
                   and btrim(coalesce(l.data->>'name', '')) = coalesce(t.lagenhetsnummer, ''))))
     order by t.gata, nullif(regexp_replace(coalesce(t.gatunummer, ''), '\D', '', 'g'), '')::int nulls last,
              t.gatunummer, t.ingang, t.lagenhetsnummer
  loop
    v_id := gen_random_uuid();
    insert into records (id, tenant_id, object_type, status, owner_user_id, data)
    values (v_id, f.tenant_id, 'd2d_lagenhet', 'ej_knackad', f.owner_user_id,
      jsonb_strip_nulls(jsonb_build_object(
        'name', a.lagenhetsnummer,
        'gatunamn', a.gata,
        'gatunummer', a.gatunummer,
        'ingang', a.ingang,
        'postnummer', a.postnummer,
        'postort', initcap(a.stad),
        'fastighetsbeteckning', coalesce(a.fastighetsbeteckning_telia, a.fastighetsbeteckning),
        'punkt_id', a.punkt_id,
        'klass', a.byggnadskategori,
        'cpe_model', a.cpe_modell,
        'befintlig_fiber_adress', a.kommunikationsoperator,
        'har_telia_bredband', a.har_telia_bredband,
        'telia_status', a.status,
        'telia_objektnummer', a.objektnummer)));
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (f.tenant_id, v_id, f.id, 'd2d_lag_fastighet') on conflict do nothing;
    v_n := v_n + 1;
  end loop;

  update records set data = data || jsonb_build_object('telia_adresser', true,
           'telia_adresser_hamtade', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI'))
   where id = f.id;
  return v_n;
end $$;
revoke all on function public.d2d_fyll_lagenheter_fran_telia(uuid) from public, anon, authenticated;
grant execute on function public.d2d_fyll_lagenheter_fran_telia(uuid) to service_role;

-- Anropas från appen (ny fastighet i projekt, eller knappen).
create or replace function public.d2d_hamta_telia_lagenheter(p_fastighet_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_n int; v_telia int;
begin
  select owner_user_id into v_owner from records
   where id = p_fastighet_id and tenant_id = my_tenant_id() and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then raise exception 'Fastigheten finns inte' using errcode = 'P0002'; end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att lägga in lägenheter' using errcode = '42501';
  end if;
  select count(*) into v_telia from d2d_telia_rader(p_fastighet_id);
  v_n := d2d_fyll_lagenheter_fran_telia(p_fastighet_id);
  return jsonb_build_object('skapade', v_n, 'i_telias_lista', v_telia);
end $$;
revoke all on function public.d2d_hamta_telia_lagenheter(uuid) from public, anon;
grant execute on function public.d2d_hamta_telia_lagenheter(uuid) to authenticated;

-- Efter en import: nya adresser till fastigheter som redan hämtat från Telia.
create or replace function public.telia_adresser_efter_import()
returns jsonb language plpgsql security definer set search_path = public as $$
declare f record; v_n int := 0; v_fast int := 0;
begin
  for f in select id from records
            where object_type = 'd2d_fastighet' and deleted_at is null and data->>'telia_adresser' = 'true'
  loop
    v_n := v_n + d2d_fyll_lagenheter_fran_telia(f.id);
    v_fast := v_fast + 1;
  end loop;
  return jsonb_build_object('fastigheter', v_fast, 'nya_lagenheter', v_n);
end $$;
revoke all on function public.telia_adresser_efter_import() from public, anon, authenticated;
grant execute on function public.telia_adresser_efter_import() to service_role;
