-- Nummerbyten / porteringar för mobilabonnemang sålda i D2D.
--
-- Säljaren anger på lägenheten (status Såld, Mobil = Ja):
--   mobil_nummerval  portera_direkt | tillfalligt | nytt_nummer
--   mobil_startdatum startdatum för abonnemanget
--   mobil_nummer     { rows: [{typ: "huvud"|"extra", tillfalligt, riktigt, agare}] }
--                    (json-fält måste vara objekt, därav rows)
--
-- När valet är "tillfalligt" och alla obligatoriska uppgifter finns skapar
-- CRM automatiskt ett nummerbytesärende (objekt "nummerbyte") + en
-- admin-uppgift. Ärendet raderas aldrig: det markeras Genomförd (med vem,
-- när och vilka nummer) eller Makulerad (om säljaren ändrat valet innan
-- admin hunnit hantera det) och ligger kvar i historiken.
--
-- Datum:  rekommenderat = signering + 15 dagar
--         senast        = startdatum − 30 dagar
--         hantera senast = det tidigaste av de två (deadlinen styr)
-- Startdatum låses för säljaren när ärendet finns; bara admin kan ändra det
-- (nummerbyte_set_startdatum), och då räknas datumen om.

-- 1. Objekt, fält, statusar ------------------------------------------------------
do $$
declare t record; v_id uuid;
begin
  for t in select id from tenants loop
    if not exists (select 1 from object_definitions where tenant_id = t.id and key = 'nummerbyte') then
      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, 'nummerbyte', 'Nummerbyte', 'Nummerbyten', 'phone', 'name', 62, true)
      returning id into v_id;

      insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility) values
        (v_id, t.id, 'name',            'Ärende',                     'text',     true,  '{"section":"grunduppgifter"}', 10, 'all'),
        (v_id, t.id, 'kund',            'Kund',                       'text',     false, '{"section":"grunduppgifter"}', 20, 'all'),
        (v_id, t.id, 'saljare',         'Säljare',                    'user',     false, '{"section":"grunduppgifter"}', 30, 'all'),
        (v_id, t.id, 'adress',          'Adress',                     'text',     false, '{"section":"grunduppgifter"}', 40, 'all'),
        (v_id, t.id, 'signeringsdatum', 'Signeringsdatum',            'date',     false, '{"section":"tidplan"}', 50, 'all'),
        (v_id, t.id, 'startdatum',      'Startdatum',                 'date',     false, '{"section":"tidplan"}', 60, 'all'),
        (v_id, t.id, 'rek_datum',       'Rekommenderat handläggningsdatum', 'date', false, '{"section":"tidplan"}', 70, 'all'),
        (v_id, t.id, 'senast_datum',    'Senaste handläggningsdatum', 'date',     false, '{"section":"tidplan","_overdue":true}', 80, 'all'),
        (v_id, t.id, 'hantera_datum',   'Hantera senast',             'date',     false, '{"section":"tidplan"}', 90, 'all'),
        (v_id, t.id, 'nummer',          'Nummer',                     'json',     false, '{"section":"ovrigt"}', 100, 'hidden'),
        (v_id, t.id, 'ansvarig_admin',  'Ansvarig admin',             'user',     false, '{"section":"grunduppgifter","owner_field":true}', 110, 'all'),
        (v_id, t.id, 'genomford_av',    'Genomförd av',               'user',     false, '{"section":"ovrigt"}', 120, 'all'),
        (v_id, t.id, 'genomford_at',    'Genomförd',                  'datetime', false, '{"section":"ovrigt"}', 130, 'all'),
        (v_id, t.id, 'lagenhet_id',     'Lägenhet (id)',              'text',     false, '{"section":"ovrigt"}', 140, 'hidden'),
        (v_id, t.id, 'kommentar',       'Kommentar',                  'long_text',false, '{"section":"ovrigt"}', 150, 'all');

      insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order) values
        (v_id, t.id, 'oppen',     'Öppen',     'amber', true,  false, 10),
        (v_id, t.id, 'genomford', 'Genomförd', 'green', false, true,  20),
        (v_id, t.id, 'makulerad', 'Makulerad', 'slate', false, true,  30);
    end if;

    -- Fält på lägenheten (säljarens uppgifter).
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select od.id, t.id, v.key, v.label, v.typ, false, v.opts::jsonb, v.sort, v.vis
      from object_definitions od
     cross join (values
       ('mobil_nummerval', 'Mobil – nummer', 'select',
          '{"section":"salt","choices":[{"key":"portera_direkt","label":"Befintligt nummer porteras direkt"},{"key":"tillfalligt","label":"Tillfälligt nummer – ersätts med befintligt"},{"key":"nytt_nummer","label":"Nytt nummer – kunden behåller det slumpade"}]}',
          575, 'all'),
       ('mobil_startdatum', 'Mobil – startdatum', 'date', '{"section":"salt"}', 576, 'all'),
       ('mobil_nummer', 'Mobil – nummer att porteras', 'json', '{"section":"salt"}', 577, 'hidden'),
       ('mobil_nummerbyte_id', 'Mobil – nummerbytesärende', 'text', '{"section":"salt"}', 578, 'hidden')
     ) as v(key, label, typ, opts, sort, vis)
     where od.tenant_id = t.id and od.key = 'd2d_lagenhet'
       and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);
  end loop;
end $$;

-- 2. Hjälpfunktioner ---------------------------------------------------------------
create or replace function public.nb_fmt_date(d date) returns text
language sql immutable as $$ select to_char(d, 'DD/MM/YYYY') $$;

/** Är mobil_nummer + startdatum kompletta för ett nummerbyte? */
create or replace function public.nb_complete(p_data jsonb) returns boolean
language sql immutable as $$
  select coalesce(p_data->>'mobil_startdatum', '') <> ''
     and jsonb_typeof(p_data->'mobil_nummer'->'rows') = 'array'
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'huvud') = 1
     and not exists (
       select 1 from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n
        where coalesce(trim(n->>'tillfalligt'), '') = ''
           or coalesce(trim(n->>'riktigt'), '') = ''
           or coalesce(trim(n->>'agare'), '') = '')
$$;

/** Text till admin-uppgiften, enligt mallen. */
create or replace function public.nb_task_text(p jsonb, p_saljare_namn text) returns text
language plpgsql stable as $$
declare v text; n jsonb; v_start date; v_days int;
begin
  v_start := nullif(p->>'startdatum', '')::date;
  v_days := case when v_start is null then null else v_start - current_date end;
  v := 'PORTERA / BYT MOBILNUMMER' || E'\n\n'
    || 'Kund: ' || coalesce(p->>'kund', '—') || E'\n'
    || 'Säljare: ' || coalesce(p_saljare_namn, '—') || E'\n'
    || 'Adress: ' || coalesce(p->>'adress', '—') || E'\n'
    || 'Signeringsdatum: ' || coalesce(public.nb_fmt_date(nullif(p->>'signeringsdatum','')::date), '—') || E'\n'
    || 'Startdatum: ' || coalesce(public.nb_fmt_date(v_start), '—') || E'\n'
    || 'Dagar kvar till start: ' || coalesce(v_days::text || ' dagar', '—') || E'\n'
    || 'Rekommenderad hantering: ' || coalesce(public.nb_fmt_date(nullif(p->>'rek_datum','')::date), '—') || E'\n'
    || 'Senaste hantering: ' || coalesce(public.nb_fmt_date(nullif(p->>'senast_datum','')::date), '—') || E'\n';
  for n in select * from jsonb_array_elements(coalesce(p->'nummer', '[]'::jsonb)) order by (value->>'typ' <> 'huvud') loop
    v := v || E'\n' || case when n->>'typ' = 'huvud' then 'Huvudnummer' else 'Extraanvändare' end || E'\n'
      || '• Tillfälligt nummer: ' || coalesce(n->>'tillfalligt', '—') || E'\n'
      || '• Ska ersättas med: ' || coalesce(n->>'riktigt', '—') || E'\n'
      || '• Nummerägare idag: ' || coalesce(n->>'agare', '—') || E'\n';
  end loop;
  v := v || E'\nInnan porteringen: kontrollera i Telias SharePoint att ingen ånger eller avbeställning har kommit in.';
  return v;
end $$;

/** Räkna om datum + skriv om uppgiften för ett ärende. */
create or replace function public.nb_refresh(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r records; v_sign date; v_start date; v_rek date; v_senast date; v_hantera date;
        v_namn text; v_task uuid;
begin
  select * into r from records where id = p_id and object_type = 'nummerbyte';
  if not found then return; end if;
  v_sign  := nullif(r.data->>'signeringsdatum', '')::date;
  v_start := nullif(r.data->>'startdatum', '')::date;
  v_rek    := v_sign + 15;
  v_senast := v_start - 30;
  v_hantera := least(v_rek, v_senast);
  update records set data = data || jsonb_build_object(
      'rek_datum', v_rek, 'senast_datum', v_senast, 'hantera_datum', coalesce(v_hantera, v_rek, v_senast))
   where id = p_id
  returning * into r;

  select coalesce(full_name, email) into v_namn from users where id = nullif(r.data->>'saljare','')::uuid;

  if r.status = 'oppen' then
    select id into v_task from tasks
     where record_id = p_id and completed_at is null order by created_at limit 1;
    if v_task is null then
      insert into tasks (tenant_id, record_id, title, description, assignee_user_id, department_id,
                         priority, due_at, created_by, created_source)
      values (r.tenant_id, p_id,
              'PORTERA / BYT MOBILNUMMER – ' || coalesce(r.data->>'kund', r.title),
              public.nb_task_text(r.data, v_namn),
              nullif(r.data->>'ansvarig_admin','')::uuid,
              (select id from departments where tenant_id = r.tenant_id and key = 'management'),
              'high',
              (coalesce(v_hantera, v_rek, v_senast)::timestamp + time '09:00') at time zone 'Europe/Stockholm',
              auth.uid(), 'workflow');
    else
      update tasks set
        title = 'PORTERA / BYT MOBILNUMMER – ' || coalesce(r.data->>'kund', r.title),
        description = public.nb_task_text(r.data, v_namn),
        assignee_user_id = nullif(r.data->>'ansvarig_admin','')::uuid,
        due_at = (coalesce(v_hantera, v_rek, v_senast)::timestamp + time '09:00') at time zone 'Europe/Stockholm',
        updated_at = now()
      where id = v_task;
    end if;
  else
    update tasks set completed_at = coalesce(completed_at, now()), completed_by = coalesce(completed_by, auth.uid())
     where record_id = p_id and completed_at is null;
  end if;
end $$;

-- 3. Lägenhet → ärende (trigger) ----------------------------------------------------
create or replace function public.d2d_nummerbyte_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_nb uuid; v_nb_row records; v_want boolean; v_payload jsonb; v_kund text; v_adress text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.object_type <> 'd2d_lagenhet' then return new; end if;

  v_nb := nullif(new.data->>'mobil_nummerbyte_id', '')::uuid;
  if v_nb is not null then
    select * into v_nb_row from records where id = v_nb and deleted_at is null;
    if not found then v_nb := null; end if;
  end if;

  v_want := new.status = 'sald'
        and new.data->>'mobil_nummerval' = 'tillfalligt'
        and public.nb_complete(new.data);

  v_kund := coalesce(nullif(trim(new.data->>'kund_namn'), ''),
                     (select n->>'agare' from jsonb_array_elements(
                        case when jsonb_typeof(new.data->'mobil_nummer'->'rows') = 'array' then new.data->'mobil_nummer'->'rows' else '[]'::jsonb end) n
                       where n->>'typ' = 'huvud' limit 1),
                     'Okänd kund');
  v_adress := trim(both ' ,' from concat_ws(', ',
      nullif(trim(concat_ws(' ', new.data->>'gatunamn', new.data->>'gatunummer')), ''),
      case when coalesce(new.data->>'ingang', '') <> '' then 'ingång ' || (new.data->>'ingang') end,
      case when coalesce(new.title, '') <> '' then 'lgh ' || new.title end,
      nullif(trim(concat_ws(' ', new.data->>'postnummer', new.data->>'postort')), '')));

  if v_want then
    v_payload := jsonb_build_object(
      'kund', v_kund,
      'adress', v_adress,
      'saljare', coalesce(new.data->>'saljare', new.owner_user_id::text),
      'startdatum', new.data->>'mobil_startdatum',
      'nummer', new.data->'mobil_nummer'->'rows',
      'lagenhet_id', new.id::text);

    if v_nb is null then
      insert into records (tenant_id, object_type, status, owner_user_id, data)
      values (new.tenant_id, 'nummerbyte', 'oppen', null,
              v_payload || jsonb_build_object(
                'name', 'Nummerbyte – ' || v_kund,
                'signeringsdatum', coalesce(nullif(new.data->>'sald_datum', ''), current_date::text)))
      returning id into v_nb;
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (new.tenant_id, v_nb, 'record_created', 'Nummerbytesärende skapat från försäljning',
              jsonb_build_object('lagenhetId', new.id), auth.uid(), 'system');
      update records set data = data || jsonb_build_object('mobil_nummerbyte_id', v_nb::text) where id = new.id;
      perform public.nb_refresh(v_nb);
    elsif v_nb_row.status = 'oppen' then
      update records set data = data || v_payload || jsonb_build_object('name', 'Nummerbyte – ' || v_kund)
       where id = v_nb;
      perform public.nb_refresh(v_nb);
    elsif v_nb_row.status = 'makulerad' then
      -- Säljaren har ändrat tillbaka till tillfälligt nummer → öppna igen.
      update records set status = 'oppen', data = data || v_payload where id = v_nb;
      perform public.nb_refresh(v_nb);
    end if;
  elsif v_nb is not null and v_nb_row.status = 'oppen'
        and (new.status <> 'sald' or coalesce(new.data->>'mobil_nummerval', '') <> 'tillfalligt') then
    -- Säljaren har valt bort tillfälligt nummer innan admin hanterat ärendet.
    update records set status = 'makulerad',
           data = data || jsonb_build_object('kommentar',
             'Makulerat automatiskt: försäljningen har inte längre ett tillfälligt nummer (' || to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI') || ').')
     where id = v_nb;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (new.tenant_id, v_nb, 'status_change', 'Makulerat – säljaren har valt bort tillfälligt nummer', '{}'::jsonb, auth.uid(), 'system');
    perform public.nb_refresh(v_nb);
  end if;
  return new;
end $$;

drop trigger if exists trg_d2d_nummerbyte_sync on public.records;
create trigger trg_d2d_nummerbyte_sync
  after insert or update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_nummerbyte_sync();

-- Säljaren får inte ändra startdatum när ärendet väl finns.
create or replace function public.d2d_lock_mobil_start()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.object_type = 'd2d_lagenhet'
     and coalesce(old.data->>'mobil_nummerbyte_id', '') <> ''
     and (new.data->>'mobil_startdatum') is distinct from (old.data->>'mobil_startdatum')
     and auth.uid() is not null and not public.is_admin() then
    raise exception 'Startdatum kan inte ändras efter att försäljningen registrerats. Kontakta admin.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_d2d_lock_mobil_start on public.records;
create trigger trg_d2d_lock_mobil_start
  before update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_lock_mobil_start();

-- 4. Admin-åtgärder -----------------------------------------------------------------
create or replace function public.nummerbyte_set_startdatum(p_id uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare r records; v_old text;
begin
  if not public.is_admin() then
    raise exception 'Bara admin kan ändra startdatum' using errcode = '42501';
  end if;
  select * into r from records where id = p_id and object_type = 'nummerbyte' and tenant_id = my_tenant_id();
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  v_old := r.data->>'startdatum';
  update records set data = data || jsonb_build_object('startdatum', p_date) where id = p_id;
  -- Spegla till lägenheten (utan att trigga ett nytt ärende).
  if coalesce(r.data->>'lagenhet_id', '') <> '' then
    update records set data = data || jsonb_build_object('mobil_startdatum', p_date)
     where id = (r.data->>'lagenhet_id')::uuid;
  end if;
  perform log_activity(p_id, 'field_change',
    'Startdatum ändrat från ' || coalesce(v_old, '—') || ' till ' || coalesce(p_date::text, '—'),
    jsonb_build_object('field', 'startdatum', 'from', v_old, 'to', p_date));
  perform public.nb_refresh(p_id);
end $$;

create or replace function public.nummerbyte_set_admin(p_id uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Bara admin kan tilldela nummerbyten' using errcode = '42501';
  end if;
  update records set data = data || jsonb_build_object('ansvarig_admin', p_user)
   where id = p_id and object_type = 'nummerbyte' and tenant_id = my_tenant_id();
  perform public.nb_refresh(p_id);
end $$;

create or replace function public.nummerbyte_complete(p_id uuid, p_confirm boolean)
returns void language plpgsql security definer set search_path = public as $$
declare r records; v_text text;
begin
  if not public.is_admin() then
    raise exception 'Bara admin kan markera nummerbyten som genomförda' using errcode = '42501';
  end if;
  if not coalesce(p_confirm, false) then
    raise exception 'Bekräfta att nummerbytet genomförts i Telias beställningsportal' using errcode = '22023';
  end if;
  select * into r from records where id = p_id and object_type = 'nummerbyte' and tenant_id = my_tenant_id();
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if r.status <> 'oppen' then raise exception 'Ärendet är redan avslutat' using errcode = '22023'; end if;

  select string_agg(
           case when n->>'typ' = 'huvud' then 'Huvudnummer' else 'Extraanvändare' end
           || ': ' || coalesce(n->>'tillfalligt','—') || ' → ' || coalesce(n->>'riktigt','—')
           || ' (ägare: ' || coalesce(n->>'agare','—') || ')', E'\n')
    into v_text
    from jsonb_array_elements(coalesce(r.data->'nummer', '[]'::jsonb)) n;

  update records set status = 'genomford',
         data = data || jsonb_build_object(
           'genomford_av', auth.uid(),
           'genomford_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'genomford_nummer', r.data->'nummer')
   where id = p_id;
  perform log_activity(p_id, 'status_change',
    'Nummerbyte/portering genomförd i Telias beställningsportal för ' || coalesce(r.data->>'kund','—') || E'\n' || coalesce(v_text, ''),
    jsonb_build_object('nummer', r.data->'nummer', 'lagenhetId', r.data->>'lagenhet_id'));
  perform public.nb_refresh(p_id);
end $$;

grant execute on function public.nummerbyte_set_startdatum(uuid, date) to authenticated;
grant execute on function public.nummerbyte_set_admin(uuid, uuid) to authenticated;
grant execute on function public.nummerbyte_complete(uuid, boolean) to authenticated;
