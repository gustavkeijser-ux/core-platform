-- Bekräftad / Ej bekräftad sälj (Gustav 26 okt).
-- När säljaren avslutar ett Såld-sälj väljer hen Bekräftad eller Ej bekräftad. Ej bekräftad
-- kräver kundens personnummer och telefon (kontrolleras i appen) och räknas som "väntar"
-- i pinnar/lön (som Scrive-signerade) tills säljaren ändrar till Bekräftad.
-- Påminnelsemejl till säljaren efter 18 och 36 timmar; vid 36 h även till admin
-- (d2d_bekraftelse_mottagare). Edge function d2d-bekraftelse-notis, pg_cron var 15:e minut.

-- 1. Fält
insert into field_definitions (object_id, tenant_id, key, label, field_type, options, visibility, sort_order)
select o.object_id, o.tenant_id, v.key, v.label, v.typ, v.opt::jsonb, v.vis, v.sort
  from (select distinct object_id, tenant_id from field_definitions where key = 'salt_bredband') o,
       (values
         ('sald_bekraftelse', 'Säljet bekräftat', 'select',
          '{"section":"forsaljning","d2d_eget_ui":true,"choices":[{"key":"bekraftad","label":"Bekräftad"},{"key":"ej_bekraftad","label":"Ej bekräftad"}]}', 'all', 362),
         ('sald_bekraftelse_tid', 'Ej bekräftad sedan', 'datetime', '{"section":"forsaljning","d2d_eget_ui":true,"readonly":true}', 'all', 363),
         ('sald_bekraftad_tid', 'Bekräftad', 'datetime', '{"section":"forsaljning","d2d_eget_ui":true,"readonly":true}', 'all', 364)
       ) v(key, label, typ, opt, vis, sort)
 where not exists (select 1 from field_definitions f where f.object_id = o.object_id and f.key = v.key);

-- 2. Tidpunkter sätts av servern när valet ändras
create or replace function public.d2d_bekraftelse_trg()
returns trigger language plpgsql set search_path = public as $$
declare v_ny text := nullif(new.data->>'sald_bekraftelse', ''); v_gl text := nullif(old.data->>'sald_bekraftelse', '');
begin
  if v_ny is distinct from v_gl then
    if v_ny = 'ej_bekraftad' then
      new.data := new.data || jsonb_build_object('sald_bekraftelse_tid', ce_iso(now()), 'sald_bekraftad_tid', null);
    elsif v_ny = 'bekraftad' then
      new.data := new.data || jsonb_build_object('sald_bekraftad_tid', ce_iso(now()));
    end if;
  end if;
  return new;
end $$;
create or replace trigger trg_d2d_bekraftelse before update on public.records
  for each row when (new.object_type = 'd2d_lagenhet') execute function public.d2d_bekraftelse_trg();

-- 3. Lön/pinnar: Såld men Ej bekräftad räknas som väntar (kalla 'signerat'), som Scrive-signerade
do $do$
declare d text := pg_get_functiondef('public.d2d_lon_affarer(uuid, timestamptz, timestamptz)'::regprocedure);
  a text := $a$           case when l.st = 'sald' then 'sald'
                when sig.t is not null then 'signerat'$a$;
  b text := $b$           case when l.st = 'sald' and l.data->>'sald_bekraftelse' = 'ej_bekraftad' then 'signerat'
                when l.st = 'sald' then 'sald'
                when sig.t is not null then 'signerat'$b$;
begin
  if position('ej_bekraftad' in d) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in d) = 0 then raise exception 'hittar inte texten'; end if;
  execute replace(d, a, b);
end $do$;

-- 4. Påminnelser
create table if not exists public.d2d_bekraftelse_mottagare (
  tenant_id uuid primary key references tenants(id),
  epost text[] not null default '{}'
);
alter table public.d2d_bekraftelse_mottagare enable row level security;
insert into d2d_bekraftelse_mottagare (tenant_id, epost)
values ('cb257a7f-5245-4a00-80d2-6a394c2c2ee1', array['gustav@connectestate.se', 'lukas@connectestate.se', 'anton.haggberg@connectestate.se'])
on conflict (tenant_id) do nothing;

create table if not exists public.d2d_bekraftelse_paminnelse (
  lagenhet_id uuid not null references records(id) on delete cascade,
  ej_tid timestamptz not null,
  typ text not null check (typ in ('18h', '36h')),
  skickad timestamptz not null default now(),
  primary key (lagenhet_id, ej_tid, typ)
);
alter table public.d2d_bekraftelse_paminnelse enable row level security;

/** Ej bekräftade Såld-sälj som passerat 18 resp. 36 timmar och inte fått den påminnelsen.
 *  Har båda gränserna passerats (t.ex. efter driftstopp) skickas bara 36 h. */
create or replace function public.d2d_bekraftelse_underlag(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', coalesce((select to_jsonb(epost) from d2d_bekraftelse_mottagare where tenant_id = p_tenant), '[]'::jsonb),
    'lista', coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'ejTid', x.ej_tid, 'typ', x.typ,
      'kund', x.data->>'kund_namn', 'telefon', x.data->>'kund_telefon',
      'adress', concat_ws(' ', x.data->>'gatunamn', x.data->>'gatunummer') || coalesce(', lgh ' || nullif(x.title, ''), '')
                || coalesce(', ' || nullif(x.data->>'postort', ''), ''),
      'saldDatum', x.data->>'sald_datum',
      'saljare', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = x.su),
      'saljareEpost', (select u.email::text from users u where u.id = x.su and u.is_active)) order by x.ej_tid), '[]'::jsonb))
  from (
    select r.id, r.title, r.data, t.ej_tid,
           case when r.data->>'saljare' ~* '^[0-9a-f-]{36}$' then (r.data->>'saljare')::uuid else r.owner_user_id end su,
           case when now() >= t.ej_tid + interval '36 hours' then '36h' else '18h' end typ
      from records r
      cross join lateral (select (r.data->>'sald_bekraftelse_tid')::timestamptz ej_tid) t
     where r.tenant_id = p_tenant and r.object_type = 'd2d_lagenhet' and r.deleted_at is null
       and r.status = 'sald' and r.data->>'sald_bekraftelse' = 'ej_bekraftad'
       and t.ej_tid is not null and now() >= t.ej_tid + interval '18 hours'
       and not exists (select 1 from d2d_bekraftelse_paminnelse p where p.lagenhet_id = r.id and p.ej_tid = t.ej_tid
                         and p.typ = case when now() >= t.ej_tid + interval '36 hours' then '36h' else '18h' end)
       and not exists (select 1 from d2d_bekraftelse_paminnelse p where p.lagenhet_id = r.id and p.ej_tid = t.ej_tid and p.typ = '36h')
  ) x
$$;
revoke all on function public.d2d_bekraftelse_underlag(uuid) from public, anon, authenticated;

create or replace function public.d2d_bekraftelse_klar(p_rader jsonb) returns void
language sql security definer set search_path = public as $$
  insert into d2d_bekraftelse_paminnelse (lagenhet_id, ej_tid, typ)
  select (x->>'id')::uuid, (x->>'ejTid')::timestamptz, x->>'typ' from jsonb_array_elements(coalesce(p_rader, '[]'::jsonb)) x
  on conflict do nothing
$$;
revoke all on function public.d2d_bekraftelse_klar(jsonb) from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'd2d-bekraftelse-notis') then
    perform cron.schedule('d2d-bekraftelse-notis', '*/15 * * * *', $c$
      select net.http_post(
        url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-bekraftelse-notis',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000) as request_id;
    $c$);
  end if;
end $$;
