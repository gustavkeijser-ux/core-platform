-- =====================================================================
--  0065 — Utfall: "Varför bara bredband" läser säljarnas kommentarer.
--  Regeln: har kunden köpt (Såld) eller signerat (Scrive) enbart
--  bredband läses kommentaren och AI tolkar varför kunden bara tog
--  bredband. Tolkningen sparas på lägenheten (data.ej_mer_ai) och Utfall
--  räknar den när säljaren inte valt något skäl själv.
--    • d2d_ej_mer_skal(d)          skälen som gäller: säljarens val, annars AI:s
--    • d2d_ej_mer_kandidater(...)  lägenheter som behöver (om)analyseras
--    • d2d_spara_ej_mer_ai(...)    sparar AI:s svar
--    • trigger + pg_cron           analysen körs direkt när någon säljer
--                                  eller signerar, och var 5:e minut för nya
--                                  eller ändrade kommentarer
--  Edge function: d2d-ej-mer-analys.
-- =====================================================================

-- Fältet (dolt) så att posten går att spara som vanligt.
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
select od.id, od.tenant_id, 'ej_mer_ai', 'Varför bara bredband (AI)', 'json', false,
       '{"section":"ai","d2d_eget_ui":true}'::jsonb, 'hidden', 99
  from object_definitions od
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'ej_mer_ai');

-- Köpte kunden mer än bredband? (samma regel som i Utfall)
create or replace function public.d2d_mer_an_bredband(d jsonb)
returns boolean language sql immutable as $$
  select coalesce((nullif(d->>'salt_tv', '') is not null
    or jsonb_array_length(d2d_arr(d->'salt_mobil')) > 0
    or nullif(d->>'salt_streaming_film', '') is not null
    or nullif(d->>'salt_streaming_sport', '') is not null
    or d->>'salt_trygghet' = 'true'), false)
$$;

-- Skälen som räknas: säljarens egna val vinner, annars AI:s tolkning.
create or replace function public.d2d_ej_mer_skal(d jsonb)
returns jsonb language sql immutable as $$
  select case
    when jsonb_array_length(d2d_arr(d->'ej_mer_anledning')) > 0 then d2d_arr(d->'ej_mer_anledning')
    when jsonb_typeof(d->'ej_mer_ai'->'skal') = 'array' then d->'ej_mer_ai'->'skal'
    else '[]'::jsonb end
$$;

-- Lägenheter med enbart bredband (Såld, Scrive eller signerat avtal) vars
-- kommentar inte är analyserad, eller har ändrats sedan analysen.
create or replace function public.d2d_ej_mer_kandidater(p_ids uuid[] default null, p_limit int default 40)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'tenant', r.tenant_id,
           'kommentar', btrim(r.data->>'kommentar'), 'hash', md5(btrim(r.data->>'kommentar')),
           'bredband', r.data->>'salt_bredband', 'router', r.data->>'salt_router')), '[]'::jsonb)
    from (select * from records r
           where r.object_type = 'd2d_lagenhet' and r.deleted_at is null
             and (p_ids is null or r.id = any(p_ids))
             and (r.status in ('sald', 'scrive')
                  or exists (select 1 from d2d_avtal a where a.lagenhet_id = r.id and a.status = 'signerat'))
             and not d2d_mer_an_bredband(r.data)
             and nullif(btrim(r.data->>'kommentar'), '') is not null
             and coalesce(r.data->'ej_mer_ai'->>'hash', '') <> md5(btrim(r.data->>'kommentar'))
           order by r.updated_at desc
           limit greatest(1, least(coalesce(p_limit, 40), 200))) r
$$;
revoke all on function public.d2d_ej_mer_kandidater(uuid[], int) from public, anon, authenticated;
grant execute on function public.d2d_ej_mer_kandidater(uuid[], int) to service_role;

-- Spara AI:s svar: [{id, hash, skal: [...], sammanfattning}]
create or replace function public.d2d_spara_ej_mer_ai(p_rader jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update records r
     set data = r.data || jsonb_build_object('ej_mer_ai', jsonb_build_object(
           'skal', coalesce(x.v->'skal', '[]'::jsonb),
           'sammanfattning', x.v->>'sammanfattning',
           'hash', x.v->>'hash',
           'analyserad', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
    from jsonb_array_elements(p_rader) x(v)
   where r.id = (x.v->>'id')::uuid and r.object_type = 'd2d_lagenhet';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.d2d_spara_ej_mer_ai(jsonb) from public, anon, authenticated;
grant execute on function public.d2d_spara_ej_mer_ai(jsonb) to service_role;

-- Anropa analysen (asynkront via pg_net).
create or replace function public.d2d_ej_mer_kor(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-ej-mer-analys',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
    body := jsonb_build_object('ids', to_jsonb(p_ids)),
    timeout_milliseconds := 120000);
exception when others then
  raise warning 'd2d_ej_mer_kor: %', sqlerrm;  -- får aldrig stoppa själva sparningen
end $$;
revoke all on function public.d2d_ej_mer_kor(uuid[]) from public, anon, authenticated;

-- Direkt när någon säljer eller går till Scrive. (Kommentarer som skrivs
-- eller ändras efteråt tas av körningen var 5:e minut, så att varje
-- autosparning medan säljaren skriver inte blir ett eget AI-anrop.)
create or replace function public.trg_d2d_ej_mer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.object_type <> 'd2d_lagenhet' or new.status not in ('sald', 'scrive') then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  if nullif(btrim(new.data->>'kommentar'), '') is null or d2d_mer_an_bredband(new.data) then return new; end if;
  if coalesce(new.data->'ej_mer_ai'->>'hash', '') = md5(btrim(new.data->>'kommentar')) then return new; end if;
  perform d2d_ej_mer_kor(array[new.id]);
  return new;
end $$;
create or replace trigger trg_d2d_ej_mer after insert or update of status on public.records
  for each row execute function public.trg_d2d_ej_mer();

create or replace function public.trg_d2d_avtal_ej_mer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'signerat' and old.status is distinct from 'signerat' then
    perform d2d_ej_mer_kor(array[new.lagenhet_id]);
  end if;
  return new;
end $$;
create or replace trigger trg_d2d_avtal_ej_mer after update of status on public.d2d_avtal
  for each row execute function public.trg_d2d_avtal_ej_mer();

-- Var 5:e minut: nya eller ändrade kommentarer, och det som missats.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'd2d-ej-mer-analys') then
    perform cron.unschedule('d2d-ej-mer-analys');
  end if;
  perform cron.schedule('d2d-ej-mer-analys', '*/5 * * * *', $cron$ select public.d2d_ej_mer_kor(null) $cron$);
end $$;

-- Utfall: räkna AI:s skäl när säljaren inte valt något, och visa tolkningen
-- bredvid kommentaren.
do $$
declare
  f text; v text;
  par text[][] := array[
    ['jsonb_array_elements_text(case when jsonb_typeof(d->''ej_mer_anledning'') = ''array'' then d->''ej_mer_anledning'' else ''[]''::jsonb end) k',
     'jsonb_array_elements_text(d2d_ej_mer_skal(d)) k'],
    ['coalesce(jsonb_array_length(case when jsonb_typeof(d->''ej_mer_anledning'') = ''array'' then d->''ej_mer_anledning'' end), 0) = 0',
     'jsonb_array_length(d2d_ej_mer_skal(d)) = 0'],
    ['jsonb_array_elements_text(d2d_arr(s.d->''ej_mer_anledning'')) k0',
     'jsonb_array_elements_text(d2d_ej_mer_skal(s.d)) k0'],
    ['''kommentar'', nullif(btrim(d->>''kommentar''), ''''),',
     '''kommentar'', nullif(btrim(d->>''kommentar''), ''''),
                 ''ai'', case when jsonb_array_length(d2d_arr(d->''ej_mer_anledning'')) = 0 then d->''ej_mer_ai''->>''sammanfattning'' end,']
  ];
  i int;
begin
  foreach f in array array['public.d2d_utfall(uuid, uuid, date, date)', 'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'] loop
    v := pg_get_functiondef(f::regprocedure);
    if position('d2d_ej_mer_skal' in v) > 0 then continue; end if;
    for i in 1 .. array_length(par, 1) loop
      if position(par[i][1] in v) = 0 then raise exception '%: hittar inte "%"', f, par[i][1]; end if;
      v := replace(v, par[i][1], par[i][2]);
    end loop;
    execute v;
  end loop;
end $$;
