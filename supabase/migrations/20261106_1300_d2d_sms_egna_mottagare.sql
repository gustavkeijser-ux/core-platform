-- Door to door → Kontaktlista → Skicka SMS: egna mottagare (Gustav 6 nov).
-- I SMS-dialogen kan man skriva in namn och mobilnummer för hand, utöver (eller
-- i stället för) kontakter ur listan. De får ett SMS med {namn} ifyllt; övriga
-- fält blir tomma. De kopplas inte till någon lägenhet men syns i utskicket.
-- d2d_sms_skapa och d2d_sms_forhand får parametern p_extra (jsonb-lista
-- [{namn, telefon}]); de tidigare signaturerna tas bort så att API:t inte får
-- två kandidater. p_ids = tom lista betyder "inga kontakter ur listan".

drop function if exists public.d2d_sms_skapa(text, text, uuid[], text, text, text[], text);
drop function if exists public.d2d_sms_forhand(text, uuid[], text, text[], text);

/** Skapar ett utskick. p_ids = markerade lägenheter (tom lista = inga); null = alla som matchar p_sok/p_status/p_ort.
    p_extra = egna mottagare [{namn, telefon}] som skrivs in för hand (kopplas inte till någon lägenhet). */
create or replace function public.d2d_sms_skapa(
  p_mall text, p_avsandare text, p_ids uuid[] default null, p_sok text default null, p_testnummer text default null,
  p_status text[] default null, p_ort text default null, p_extra jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_t uuid := my_tenant_id(); v_id uuid; v_mall text := trim(coalesce(p_mall, ''));
  v_avs text := trim(coalesce(p_avsandare, '')); v_test text;
  v_valda int; v_ej_mobil int; v_sparr int; v_dubbel int; v_antal int; v_extra int := 0; v_fel text;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS från kontaktlistan' using errcode = '42501';
  end if;
  if v_mall = '' then raise exception 'Skriv ett meddelande' using errcode = '22023'; end if;
  if length(v_mall) > 600 then raise exception 'Meddelandet är för långt (högst 600 tecken)' using errcode = '22023'; end if;
  if not (v_avs ~ '^[A-Za-z0-9][A-Za-z0-9 .-]{0,10}$' or v_avs ~ '^\+?\d{7,15}$') then
    raise exception 'Avsändaren ska vara högst 11 bokstäver/siffror (t.ex. Connectest) eller ett telefonnummer' using errcode = '22023';
  end if;

  -- Egna mottagare: varje nummer måste vara ett svenskt mobilnummer.
  if p_extra is not null and jsonb_typeof(p_extra) = 'array' then
    select string_agg(coalesce(e->>'telefon', '(tomt)'), ', ') into v_fel
      from jsonb_array_elements(p_extra) e where d2d_sms_mobil(e->>'telefon') is null;
    if v_fel is not null then
      raise exception 'Inte svenska mobilnummer: %', v_fel using errcode = '22023';
    end if;
    v_extra := jsonb_array_length(p_extra);
    if v_extra > 200 then raise exception 'Högst 200 egna mottagare per utskick' using errcode = '22023'; end if;
  end if;

  -- Urvalet räknas om i varje steg (ingen temporär tabell).
  select count(*),
         count(*) filter (where u.mobil is null),
         count(*) filter (where u.mobil is not null and exists
           (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = u.mobil and s.aktiv))
    into v_valda, v_ej_mobil, v_sparr
    from (select d2d_sms_mobil(k.telefon) as mobil
            from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end,
                                    case when p_ids is null then p_status end, case when p_ids is null then p_ort end) k
           where p_ids is null or k.id = any(p_ids)) u;
  v_valda := v_valda + v_extra;
  if v_valda = 0 then raise exception 'Inga mottagare valda' using errcode = '22023'; end if;

  if p_testnummer is not null then
    v_test := d2d_sms_mobil(p_testnummer);
    if v_test is null then raise exception 'Testnumret är inte ett svenskt mobilnummer' using errcode = '22023'; end if;
    insert into d2d_sms_utskick (tenant_id, skapad_av, avsandare, mall, test, antal_valda)
      values (v_t, auth.uid(), v_avs, v_mall, true, 1) returning id into v_id;
    insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
      select v_id, v_t, null, v_test, d2d_sms_fyll(v_mall, k.namn, k.gata, k.lgh, k.postort)
        from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end,
                                    case when p_ids is null then p_status end, case when p_ids is null then p_ort end) k
       where p_ids is null or k.id = any(p_ids)
       order by k.inkom desc limit 1;
    if not found then
      insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
        select v_id, v_t, null, v_test, d2d_sms_fyll(v_mall, nullif(trim(e->>'namn'), ''), null, null, null)
          from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e limit 1;
    end if;
    return jsonb_build_object('id', v_id, 'antal', 1, 'valda', 1, 'test', true);
  end if;

  insert into d2d_sms_utskick (tenant_id, skapad_av, avsandare, mall, sok, antal_valda)
    values (v_t, auth.uid(), v_avs, v_mall, case when p_ids is null then d2d_kontakt_filtertext(p_sok, p_status, p_ort) end, v_valda)
    returning id into v_id;
  insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
    select distinct on (u.mobil) v_id, v_t, u.id, u.mobil, u.text
      from (select k.id, k.inkom, d2d_sms_mobil(k.telefon) as mobil,
                   d2d_sms_fyll(v_mall, k.namn, k.gata, k.lgh, k.postort) as text
              from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end,
                                    case when p_ids is null then p_status end, case when p_ids is null then p_ort end) k
             where p_ids is null or k.id = any(p_ids)) u
     where u.mobil is not null
       and not exists (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = u.mobil and s.aktiv)
     order by u.mobil, u.inkom desc;
  get diagnostics v_antal = row_count;
  -- Egna mottagare (spärrade hoppas över, ett SMS per nummer).
  with ins as (
    insert into d2d_sms_mottagare (utskick_id, tenant_id, lagenhet_id, telefon, text)
      select distinct on (x.mobil) v_id, v_t, null, x.mobil, d2d_sms_fyll(v_mall, x.namn, null, null, null)
        from (select d2d_sms_mobil(e->>'telefon') as mobil, nullif(trim(e->>'namn'), '') as namn
                from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e) x
       where not exists (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = x.mobil and s.aktiv)
       order by x.mobil
    on conflict (utskick_id, telefon) do nothing
    returning 1)
  select v_antal + count(*) into v_antal from ins;
  v_sparr := v_sparr + (select count(*) from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e
                         where exists (select 1 from d2d_sms_sparr s where s.tenant_id = v_t and s.telefon = d2d_sms_mobil(e->>'telefon') and s.aktiv));
  v_dubbel := v_valda - v_ej_mobil - v_sparr - v_antal;
  update d2d_sms_utskick set bortvalda = jsonb_build_object('ej_mobil', v_ej_mobil, 'sparrade', v_sparr, 'dubbletter', v_dubbel)
   where id = v_id;
  return jsonb_build_object('id', v_id, 'antal', v_antal, 'valda', v_valda,
                            'ej_mobil', v_ej_mobil, 'sparrade', v_sparr, 'dubbletter', v_dubbel, 'test', false);
end $$;

/** Förhandsgranskning utan att något sparas: antal och de första texterna. */
create or replace function public.d2d_sms_forhand(p_mall text, p_ids uuid[] default null, p_sok text default null,
                                                   p_status text[] default null, p_ort text default null, p_extra jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); r jsonb;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet att skicka SMS från kontaktlistan' using errcode = '42501';
  end if;
  with u as (
    select k.id, d2d_sms_mobil(k.telefon) as mobil, k.telefon,
           d2d_sms_fyll(coalesce(p_mall, ''), k.namn, k.gata, k.lgh, k.postort) as text
      from d2d_kontakt_rader(v_t, case when p_ids is null then p_sok end,
                                    case when p_ids is null then p_status end, case when p_ids is null then p_ort end) k
     where p_ids is null or k.id = any(p_ids)
    union all
    select null::uuid, d2d_sms_mobil(e->>'telefon'), e->>'telefon',
           d2d_sms_fyll(coalesce(p_mall, ''), nullif(trim(e->>'namn'), ''), null, null, null)
      from jsonb_array_elements(case when jsonb_typeof(p_extra) = 'array' then p_extra else '[]'::jsonb end) e
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
                           from (select * from m where mobil is not null and not sparrad order by id nulls first limit 3) x), '[]'::jsonb))
    into r from m;
  return r;
end $$;

revoke all on function public.d2d_sms_skapa(text, text, uuid[], text, text, text[], text, jsonb) from public, anon;
revoke all on function public.d2d_sms_forhand(text, uuid[], text, text[], text, jsonb) from public, anon;
grant execute on function public.d2d_sms_skapa(text, text, uuid[], text, text, text[], text, jsonb) to authenticated;
grant execute on function public.d2d_sms_forhand(text, uuid[], text, text[], text, jsonb) to authenticated;
