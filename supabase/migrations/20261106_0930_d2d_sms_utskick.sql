-- Door to door → Kontaktlista: SMS-utskick till flera kontakter samtidigt.
--
-- Flöde:
--  1. d2d_sms_skapa (inloggad, behörig till kontaktlistan): urval (markerade
--     lägenheter eller alla som matchar sökningen) + mall + avsändare →
--     ett utskick med en rad per unikt mobilnummer. Texten fylls i per
--     mottagare ({namn}, {adress}, {lgh}, {ort}). Spärrade nummer och nummer
--     som inte är svenska mobilnummer tas bort. Med p_testnummer skapas ett
--     testutskick till bara det numret (texten fylls från första kontakten).
--  2. Edge function d2d-sms-skicka hämtar rader med d2d_sms_ta_rader (märks
--     'skickar' så att ingen rad kan skickas två gånger), skickar via
--     LeadDesk (Original API send_sms) och rapporterar med d2d_sms_rapportera.
--     Skickade SMS loggas som kommunikation (kanal sms) på lägenheten och som
--     aktivitet i lägenhetens historik.
--
-- Säkerhet: tabellerna har RLS utan policyer och inga rättigheter för
-- anon/authenticated — allt går via funktionerna, som kräver
-- d2d_kontakt_behorig() (samma personer som ser kontaktlistan). Varje
-- utskick syns i kontaktlistans logg (d2d_kontakt_logglista).

create table if not exists public.d2d_sms_utskick (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  skapad_av   uuid references public.users(id) on delete set null,
  skapad      timestamptz not null default now(),
  avsandare   text not null,
  mall        text not null,
  test        boolean not null default false,
  sok         text,
  antal_valda integer not null default 0,
  bortvalda   jsonb not null default '{}'::jsonb
);
alter table public.d2d_sms_utskick enable row level security;
revoke all on public.d2d_sms_utskick from anon, authenticated;
create index if not exists d2d_sms_utskick_tid_idx on public.d2d_sms_utskick (tenant_id, skapad desc);

create table if not exists public.d2d_sms_mottagare (
  id          uuid primary key default gen_random_uuid(),
  utskick_id  uuid not null references public.d2d_sms_utskick(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  lagenhet_id uuid references public.records(id) on delete set null,
  telefon     text not null,
  text        text not null,
  status      text not null default 'koad' check (status in ('koad', 'skickar', 'skickad', 'fel')),
  fel         text,
  svar        jsonb,
  skickad     timestamptz,
  unique (utskick_id, telefon)
);
alter table public.d2d_sms_mottagare enable row level security;
revoke all on public.d2d_sms_mottagare from anon, authenticated;
create index if not exists d2d_sms_mottagare_status_idx on public.d2d_sms_mottagare (utskick_id, status);
create index if not exists d2d_sms_mottagare_lgh_idx on public.d2d_sms_mottagare (lagenhet_id);

create table if not exists public.d2d_sms_sparr (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  telefon   text not null,
  orsak     text,
  skapad_av uuid references public.users(id) on delete set null,
  skapad    timestamptz not null default now(),
  aktiv     boolean not null default true,
  primary key (tenant_id, telefon)
);
alter table public.d2d_sms_sparr enable row level security;
revoke all on public.d2d_sms_sparr from anon, authenticated;

/** Svenskt mobilnummer i formen +467XXXXXXXX, annars null. */
create or replace function public.d2d_sms_mobil(p text)
returns text language sql immutable set search_path = public as $$
  select case when n ~ '^\+467[02369]\d{7}$' then n end
    from (select leaddesk_telefon_norm(p, 'SE') as n) x
$$;

/** Fyller i mallens fält för en kontakt. */
create or replace function public.d2d_sms_fyll(p_mall text, p_namn text, p_adress text, p_lgh text, p_ort text)
returns text language sql immutable set search_path = public as $$
  select trim(replace(replace(replace(replace(p_mall,
           '{namn}', coalesce(p_namn, '')), '{adress}', coalesce(p_adress, '')),
           '{lgh}', coalesce(p_lgh, '')), '{ort}', coalesce(p_ort, '')))
$$;

/** Skapar ett utskick. p_ids = markerade lägenheter; null = alla som matchar p_sok. */
create or replace function public.d2d_sms_skapa(
  p_mall text, p_avsandare text, p_ids uuid[] default null, p_sok text default null, p_testnummer text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_t uuid := my_tenant_id(); v_id uuid; v_mall text := trim(coalesce(p_mall, ''));
  v_avs text := trim(coalesce(p_avsandare, '')); v_test text;
  v_valda int; v_ej_mobil int; v_sparr int; v_dubbel int; v_antal int;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS från kontaktlistan' using errcode = '42501';
  end if;
  if v_mall = '' then raise exception 'Skriv ett meddelande' using errcode = '22023'; end if;
  if length(v_mall) > 600 then raise exception 'Meddelandet är för långt (högst 600 tecken)' using errcode = '22023'; end if;
  if not (v_avs ~ '^[A-Za-z0-9][A-Za-z0-9 .-]{0,10}$' or v_avs ~ '^\+?\d{7,15}$') then
    raise exception 'Avsändaren ska vara högst 11 bokstäver/siffror (t.ex. Connectest) eller ett telefonnummer' using errcode = '22023';
  end if;

  -- Urvalet räknas om i varje steg (ingen temporär tabell).
  select count(*),
         count(*) filter (where u.mobil is null),
         count(*) filter (where u.mobil is not null and exists
           (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = u.mobil and s.aktiv))
    into v_valda, v_ej_mobil, v_sparr
    from (select d2d_sms_mobil(k.telefon) as mobil
            from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end) k
           where p_ids is null or k.id = any(p_ids)) u;
  if v_valda = 0 then raise exception 'Inga kontakter valda' using errcode = '22023'; end if;

  if p_testnummer is not null then
    v_test := d2d_sms_mobil(p_testnummer);
    if v_test is null then raise exception 'Testnumret är inte ett svenskt mobilnummer' using errcode = '22023'; end if;
    insert into d2d_sms_utskick (tenant_id, skapad_av, avsandare, mall, test, antal_valda)
      values (v_t, auth.uid(), v_avs, v_mall, true, 1) returning id into v_id;
    insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
      select v_id, v_t, null, v_test, d2d_sms_fyll(v_mall, k.namn, k.gata, k.lgh, k.postort)
        from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end) k
       where p_ids is null or k.id = any(p_ids)
       order by k.inkom desc limit 1;
    return jsonb_build_object('id', v_id, 'antal', 1, 'valda', 1, 'test', true);
  end if;

  insert into d2d_sms_utskick (tenant_id, skapad_av, avsandare, mall, sok, antal_valda)
    values (v_t, auth.uid(), v_avs, v_mall, case when p_ids is null then nullif(trim(p_sok), '') end, v_valda)
    returning id into v_id;
  insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
    select distinct on (u.mobil) v_id, v_t, u.id, u.mobil, u.text
      from (select k.id, k.inkom, d2d_sms_mobil(k.telefon) as mobil,
                   d2d_sms_fyll(v_mall, k.namn, k.gata, k.lgh, k.postort) as text
              from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end) k
             where p_ids is null or k.id = any(p_ids)) u
     where u.mobil is not null
       and not exists (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = u.mobil and s.aktiv)
     order by u.mobil, u.inkom desc;
  get diagnostics v_antal = row_count;
  v_dubbel := v_valda - v_ej_mobil - v_sparr - v_antal;
  update d2d_sms_utskick set bortvalda = jsonb_build_object('ej_mobil', v_ej_mobil, 'sparrade', v_sparr, 'dubbletter', v_dubbel)
   where id = v_id;
  return jsonb_build_object('id', v_id, 'antal', v_antal, 'valda', v_valda,
                            'ej_mobil', v_ej_mobil, 'sparrade', v_sparr, 'dubbletter', v_dubbel, 'test', false);
end $$;

/** Förhandsgranskning utan att något sparas: antal och de första texterna. */
create or replace function public.d2d_sms_forhand(p_mall text, p_ids uuid[] default null, p_sok text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); r jsonb;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS från kontaktlistan' using errcode = '42501';
  end if;
  with u as (
    select k.id, d2d_sms_mobil(k.telefon) as mobil, k.telefon,
           d2d_sms_fyll(coalesce(p_mall, ''), k.namn, k.gata, k.lgh, k.postort) as text
      from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end) k
     where p_ids is null or k.id = any(p_ids)
  ), m as (
    select u.*, exists (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = u.mobil and s.aktiv) as sparrad from u
  )
  select jsonb_build_object(
    'valda', count(*),
    'ej_mobil', count(*) filter (where mobil is null),
    'sparrade', count(*) filter (where mobil is not null and sparrad),
    'mottagare', count(distinct mobil) filter (where mobil is not null and not sparrad),
    'langst', coalesce(max(length(text)) filter (where mobil is not null and not sparrad), 0),
    'exempel', coalesce((select jsonb_agg(jsonb_build_object('telefon', x.telefon, 'text', x.text))
                           from (select * from m where mobil is not null and not sparrad order by id limit 3) x), '[]'::jsonb))
    into r from m;
  return r;
end $$;

/** Edge function: tar upp till p_max köade rader och märker dem 'skickar'. */
create or replace function public.d2d_sms_ta_rader(p_utskick uuid, p_max integer default 40)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_avs text; v_rader jsonb;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS' using errcode = '42501';
  end if;
  select avsandare into v_avs from d2d_sms_utskick where id = p_utskick and tenant_id = v_t;
  if v_avs is null then raise exception 'Utskicket finns inte' using errcode = 'P0002'; end if;
  with valda as (
    select id from d2d_sms_mottagare
     where utskick_id = p_utskick and status = 'koad'
     order by telefon limit least(greatest(coalesce(p_max, 40), 1), 100)
     for update skip locked
  ), tagna as (
    update d2d_sms_mottagare m set status = 'skickar' from valda where m.id = valda.id
    returning m.id, m.telefon, m.text
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'telefon', telefon, 'text', text)), '[]'::jsonb)
    into v_rader from tagna;
  return jsonb_build_object('avsandare', v_avs, 'rader', v_rader);
end $$;

/** Edge function: resultat för en rad. Skickat SMS loggas på lägenheten. */
create or replace function public.d2d_sms_rapportera(p_rad uuid, p_ok boolean, p_fel text default null, p_svar jsonb default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); m record; v_avs text; v_comm uuid;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS' using errcode = '42501';
  end if;
  update d2d_sms_mottagare
     set status = case when p_ok then 'skickad' else 'fel' end,
         fel = case when p_ok then null else left(coalesce(p_fel, 'Okänt fel'), 500) end,
         svar = p_svar, skickad = case when p_ok then now() end
   where id = p_rad and tenant_id = v_t and status = 'skickar'
  returning * into m;
  if m.id is null or not p_ok or m.lagenhet_id is null then return; end if;

  select avsandare into v_avs from d2d_sms_utskick where id = m.utskick_id;
  insert into communications (tenant_id, channel, direction, provider, external_id, subject, body_text,
                              from_address, to_addresses, occurred_at, raw, author_user_id, processing_status,
                              send_status, sent_at)
  values (v_t, 'sms', 'outbound', 'leaddesk', 'leaddesk-sms:' || m.id, 'SMS till ' || m.telefon, m.text,
          v_avs, array[m.telefon], now(), jsonb_build_object('utskick', m.utskick_id, 'svar', p_svar),
          auth.uid(), 'done', 'sent', now())
  on conflict (tenant_id, provider, external_id) do nothing
  returning id into v_comm;
  if v_comm is not null then
    insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason, confirmed_at, confirmed_by)
      values (v_comm, m.lagenhet_id, v_t, 1.00, 'user', 'SMS-utskick från kontaktlistan', now(), auth.uid())
      on conflict do nothing;
    perform log_activity(m.lagenhet_id, 'note', 'SMS skickat till ' || m.telefon || E':\n' || m.text,
      jsonb_build_object('kanal', 'sms', 'utskick', m.utskick_id, 'communicationId', v_comm));
  end if;
end $$;

/** Status för ett utskick (visas medan det skickas). */
create or replace function public.d2d_sms_status(p_utskick uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); r jsonb;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet' using errcode = '42501';
  end if;
  select jsonb_build_object(
      'koad', count(*) filter (where status = 'koad'),
      'skickar', count(*) filter (where status = 'skickar'),
      'skickad', count(*) filter (where status = 'skickad'),
      'fel', count(*) filter (where status = 'fel'),
      'fellista', coalesce(jsonb_agg(jsonb_build_object('telefon', telefon, 'fel', fel)) filter (where status = 'fel'), '[]'::jsonb))
    into r from d2d_sms_mottagare where utskick_id = p_utskick and tenant_id = v_t;
  return r;
end $$;

/** Tidigare utskick (senaste 30). */
create or replace function public.d2d_sms_historik()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'skapad', u.skapad, 'vem', coalesce(us.full_name, us.email),
             'avsandare', u.avsandare, 'mall', u.mall, 'test', u.test, 'valda', u.antal_valda,
             'skickad', (select count(*) from d2d_sms_mottagare m where m.utskick_id = u.id and m.status = 'skickad'),
             'fel', (select count(*) from d2d_sms_mottagare m where m.utskick_id = u.id and m.status = 'fel'),
             'kvar', (select count(*) from d2d_sms_mottagare m where m.utskick_id = u.id and m.status in ('koad', 'skickar')))
           order by u.skapad desc)
      from (select * from d2d_sms_utskick where tenant_id = my_tenant_id() order by skapad desc limit 30) u
      left join users us on us.id = u.skapad_av), '[]'::jsonb);
end $$;

/** Spärra / häva spärr för ett nummer (t.ex. när kunden inte vill ha SMS). */
create or replace function public.d2d_sms_sparra(p_telefon text, p_sparra boolean default true, p_orsak text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_n text := d2d_sms_mobil(p_telefon);
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet' using errcode = '42501';
  end if;
  if v_n is null then raise exception 'Inte ett svenskt mobilnummer' using errcode = '22023'; end if;
  insert into d2d_sms_sparr (tenant_id, telefon, orsak, skapad_av, skapad, aktiv)
    values (v_t, v_n, nullif(trim(p_orsak), ''), auth.uid(), now(), p_sparra)
    on conflict (tenant_id, telefon) do update
      set aktiv = excluded.aktiv, orsak = coalesce(excluded.orsak, d2d_sms_sparr.orsak),
          skapad_av = excluded.skapad_av, skapad = excluded.skapad;
  return jsonb_build_object('telefon', v_n, 'sparrad', p_sparra);
end $$;

/** Spärrade nummer. */
create or replace function public.d2d_sms_sparrlista()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('telefon', s.telefon, 'orsak', s.orsak, 'skapad', s.skapad,
                                                       'vem', coalesce(u.full_name, u.email)) order by s.skapad desc)
                     from d2d_sms_sparr s left join users u on u.id = s.skapad_av
                    where s.tenant_id = my_tenant_id() and s.aktiv), '[]'::jsonb);
end $$;

/** Kontaktlistans logg: visningar, exporter och SMS-utskick (senaste 100). */
create or replace function public.d2d_kontakt_logglista()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet till kontaktlistan' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('tid', g.tid, 'handling', g.handling, 'sok', g.sok, 'antal', g.antal,
                                                       'vem', coalesce(u.full_name, u.email)) order by g.tid desc)
                     from (select * from (
                             select tid, handling, sok, antal, user_id from d2d_kontakt_logg where tenant_id = my_tenant_id()
                             union all
                             select s.skapad, case when s.test then 'smstest' else 'sms' end, s.sok,
                                    (select count(*)::int from d2d_sms_mottagare m where m.utskick_id = s.id), s.skapad_av
                               from d2d_sms_utskick s where s.tenant_id = my_tenant_id()) a
                            order by tid desc limit 100) g
                     left join users u on u.id = g.user_id), '[]'::jsonb);
end $$;

revoke all on function public.d2d_sms_mobil(text) from public, anon;
revoke all on function public.d2d_sms_fyll(text, text, text, text, text) from public, anon;
revoke all on function public.d2d_sms_skapa(text, text, uuid[], text, text) from public, anon;
revoke all on function public.d2d_sms_forhand(text, uuid[], text) from public, anon;
revoke all on function public.d2d_sms_ta_rader(uuid, integer) from public, anon;
revoke all on function public.d2d_sms_rapportera(uuid, boolean, text, jsonb) from public, anon;
revoke all on function public.d2d_sms_status(uuid) from public, anon;
revoke all on function public.d2d_sms_historik() from public, anon;
revoke all on function public.d2d_sms_sparra(text, boolean, text) from public, anon;
revoke all on function public.d2d_sms_sparrlista() from public, anon;
grant execute on function public.d2d_sms_mobil(text) to authenticated;
grant execute on function public.d2d_sms_skapa(text, text, uuid[], text, text) to authenticated;
grant execute on function public.d2d_sms_forhand(text, uuid[], text) to authenticated;
grant execute on function public.d2d_sms_ta_rader(uuid, integer) to authenticated;
grant execute on function public.d2d_sms_rapportera(uuid, boolean, text, jsonb) to authenticated;
grant execute on function public.d2d_sms_status(uuid) to authenticated;
grant execute on function public.d2d_sms_historik() to authenticated;
grant execute on function public.d2d_sms_sparra(text, boolean, text) to authenticated;
grant execute on function public.d2d_sms_sparrlista() to authenticated;
