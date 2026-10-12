-- D2D nummerbyten/porteringar:
--  1. Säljaren fyller inte längre i det tillfälliga/slumpade numret (irrelevant):
--     nb_complete kräver bara startdatum + kundens nummer + vem som står på det.
--     nb_task_text skriver "(inget tillfälligt nummer angivet)" när det saknas.
--  2. Mejlpåminnelse till Lukas (och ansvarig admin) när ett öppet nummerbyte har
--     2 arbetsdagar kvar till "Senaste hantering" (senast_datum), och igen när det är
--     1 arbetsdag kvar om det fortfarande inte är markerat som genomfört. Helger och
--     svenska helgdagar räknas bort (d2d_arbetsdagar_fore): ska porteringen vara
--     inskickad senast måndag går första mejlet torsdagen innan och andra på fredagen.
--     Edge function d2d-nummerbyte-notis (pg_cron 05:05 och 11:05 UTC) hämtar
--     d2d_nummerbyte_notis_underlag, skickar via Graph från ärendebrevlådan och
--     markerar med d2d_nummerbyte_notis_klar (fälten paminnelse_2d/paminnelse_1d).
--     Mottagare: tabellen d2d_nummerbyte_notis_mottagare (Lukas) + ansvarig admin.

-- ── 1. Tillfälligt nummer inte längre obligatoriskt ────────────────────────
create or replace function public.nb_complete(p_data jsonb) returns boolean
language sql immutable as $$
  select coalesce(p_data->>'mobil_startdatum', '') <> ''
     and jsonb_typeof(p_data->'mobil_nummer'->'rows') = 'array'
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'huvud') = 1
     and not exists (
       select 1 from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n
        where coalesce(trim(n->>'riktigt'), '') = ''
           or coalesce(trim(n->>'agare'), '') = '')
$$;

do $$
declare src text; a text := '''• Tillfälligt nummer: '' || coalesce(n->>''tillfalligt'', ''—'')';
begin
  src := pg_get_functiondef('public.nb_task_text'::regproc);
  if src like '%nullif(n->>''tillfalligt'', '''') is null%' then return; end if;
  if position(a in src) = 0 then raise exception 'nb_task_text: hittar inte raden för tillfälligt nummer'; end if;
  execute replace(src, a, 'case when nullif(n->>''tillfalligt'', '''') is null then ''(inget tillfälligt nummer angivet)'' else ''• Tillfälligt nummer: '' || (n->>''tillfalligt'') end');
end $$;

-- ── 2. Arbetsdagar och svenska helgdagar ──────────────────────────────────
/** Påskdagen (gregoriansk, Meeus/Jones/Butcher). */
create or replace function public.d2d_paskdagen(p_ar int) returns date
language plpgsql immutable as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; v_man int; v_dag int;
begin
  a := p_ar % 19; b := p_ar / 100; c := p_ar % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19*a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2*e + 2*i - h - k) % 7; m := (a + 11*h + 22*l) / 451;
  v_man := (h + l - 7*m + 114) / 31; v_dag := ((h + l - 7*m + 114) % 31) + 1;
  return make_date(p_ar, v_man, v_dag);
end $$;

/** Svenska allmänna helgdagar (+ midsommarafton, julafton, nyårsafton som räknas som lediga). */
create or replace function public.d2d_ar_helgdag(p_dag date) returns boolean
language plpgsql immutable as $$
declare v_ar int := extract(year from p_dag)::int; v_pask date := public.d2d_paskdagen(extract(year from p_dag)::int);
        v_md date;
begin
  if extract(isodow from p_dag) >= 6 then return true; end if;
  -- Fasta
  if (extract(month from p_dag), extract(day from p_dag)) in ((1,1),(1,6),(5,1),(6,6),(12,24),(12,25),(12,26),(12,31)) then return true; end if;
  -- Rörliga kring påsk: långfredag, annandag påsk, Kristi himmelsfärdsdag (nationaldagen är fast)
  if p_dag in (v_pask - 2, v_pask + 1, v_pask + 39) then return true; end if;
  -- Midsommarafton: fredagen 19–25 juni
  v_md := make_date(v_ar, 6, 19); while extract(isodow from v_md) <> 5 loop v_md := v_md + 1; end loop;
  if p_dag = v_md then return true; end if;
  -- Alla helgons dag: lördag 31 okt–6 nov (redan helg) — ingen extra ledig vardag.
  return false;
end $$;

/** Datumet n arbetsdagar före p_dag (helger och helgdagar hoppas över). */
create or replace function public.d2d_arbetsdagar_fore(p_dag date, p_n int) returns date
language plpgsql immutable as $$
declare v date := p_dag; n int := 0;
begin
  if p_dag is null then return null; end if;
  while n < p_n loop
    v := v - 1;
    if not public.d2d_ar_helgdag(v) then n := n + 1; end if;
  end loop;
  return v;
end $$;

-- ── 3. Mottagare, fält och underlag ───────────────────────────────────────
create table if not exists public.d2d_nummerbyte_notis_mottagare (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  epost     text[] not null default '{}'
);
alter table public.d2d_nummerbyte_notis_mottagare enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'd2d_nummerbyte_notis_mottagare' and policyname = 'admin läser') then
    create policy "admin läser" on public.d2d_nummerbyte_notis_mottagare for select to authenticated
      using (tenant_id = (auth.jwt()->'app_metadata'->>'tenant_id')::uuid);
  end if;
end $$;

insert into public.d2d_nummerbyte_notis_mottagare (tenant_id, epost)
select u.tenant_id, array_agg(distinct u.email) from public.users u
 where u.email = 'lukas@connectestate.se' group by u.tenant_id
on conflict (tenant_id) do nothing;

do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'nummerbyte';
    if v_obj is null then continue; end if;
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select v_obj, t.id, v.key, v.label, 'datetime', false, '{"section":"handlaggning","readonly":true}'::jsonb, v.sort, 'hidden'
      from (values ('paminnelse_2d', 'Påminnelse skickad (2 arbetsdagar kvar)', 90),
                   ('paminnelse_1d', 'Påminnelse skickad (1 arbetsdag kvar)', 91)) v(key, label, sort)
     where not exists (select 1 from field_definitions f where f.object_id = v_obj and f.key = v.key);
  end loop;
end $$;

/** Öppna nummerbyten som ska påminnas om i dag (2 resp. 1 arbetsdag kvar). */
create or replace function public.d2d_nummerbyte_notis_underlag(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_idag date := (now() at time zone 'Europe/Stockholm')::date; v_mott text[];
begin
  select epost into v_mott from d2d_nummerbyte_notis_mottagare where tenant_id = p_tenant;
  return jsonb_build_object(
    'idag', v_idag,
    'mottagare', coalesce(to_jsonb(v_mott), '[]'::jsonb),
    'lista', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'typ', case when v_idag >= d2d_arbetsdagar_fore(sen, 1) and r.data->>'paminnelse_1d' is null then '1d' else '2d' end,
        'kund', r.data->>'kund', 'adress', r.data->>'adress',
        'saljare', (select full_name from users where id = nullif(r.data->>'saljare','')::uuid),
        'ansvarigEpost', (select email from users where id = nullif(r.data->>'ansvarig_admin','')::uuid and is_active),
        'startdatum', r.data->>'startdatum', 'senastDatum', r.data->>'senast_datum',
        'arbetsdagarKvar', (select count(*) from generate_series(v_idag, sen - 1, '1 day') d where not d2d_ar_helgdag(d::date)),
        'nummer', coalesce(r.data->'nummer', '[]'::jsonb)) order by sen)
      from (select r.*, nullif(r.data->>'senast_datum','')::date sen from records r
             where r.tenant_id = p_tenant and r.object_type = 'nummerbyte' and r.status = 'oppen') r
      where sen is not null
        and ((v_idag >= d2d_arbetsdagar_fore(sen, 1) and r.data->>'paminnelse_1d' is null)
          or (v_idag >= d2d_arbetsdagar_fore(sen, 2) and r.data->>'paminnelse_2d' is null and r.data->>'paminnelse_1d' is null))
    ), '[]'::jsonb));
end $$;
revoke all on function public.d2d_nummerbyte_notis_underlag(uuid) from public, anon, authenticated;

/** Markera skickade påminnelser: p_rader = [{"id": uuid, "typ": "2d"|"1d"}]. */
create or replace function public.d2d_nummerbyte_notis_klar(p_rader jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare x jsonb;
begin
  for x in select * from jsonb_array_elements(coalesce(p_rader, '[]'::jsonb)) loop
    update records set data = data
      || case when x->>'typ' = '1d'
              then jsonb_build_object('paminnelse_1d', ce_iso(now()), 'paminnelse_2d', coalesce(data->>'paminnelse_2d', ce_iso(now())))
              else jsonb_build_object('paminnelse_2d', ce_iso(now())) end
     where id = (x->>'id')::uuid and object_type = 'nummerbyte';
  end loop;
end $$;
revoke all on function public.d2d_nummerbyte_notis_klar(jsonb) from public, anon, authenticated;

-- ── 4. Cron: 05:05 och 11:05 UTC (07/08 resp. 13/14 svensk tid; andra körningen är reserv) ──
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'd2d-nummerbyte-notis') then
    perform cron.schedule('d2d-nummerbyte-notis', '5 5,11 * * *', $c$
      select net.http_post(
        url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-nummerbyte-notis',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000) as request_id;
    $c$);
  end if;
end $$;
