-- D2D: VT-beställningar — uppgift för när ett signerat Scrive-avtal senast måste beställas i VT.
--
-- När en lägenhet får ett signerat Scrive-avtal (data.scrive_signerad, status scrive/sald) skapas
-- automatiskt en "VT-beställning" (objekt vt_bestallning) — samma upplägg som nummerbyten:
--   * Mobil:   helst 45 dagar, senast 30 dagar före mobilens startdatum
--              (mobil_startdatum, annars startdatum_tjanst).
--   * Övrigt:  senast 30 dagar före startdatum_tjanst.
--   Beställningen gäller hela avtalet, så helst/senast = det tidigaste av ovanstående.
--   Faller datumet på helg eller helgdag flyttas det till arbetsdagen innan.
-- Säljaren ser sina beställningar i D2D-sälj (Signerade) och markerar "Beställd i VT";
-- admin (standard Lukas) får en uppgift och ser alla under Door to door → VT-beställningar.
-- Mejl (edge function d2d-vt-notis, pg_cron 05:10 och 11:10 UTC) till Lukas, ansvarig admin
-- och säljaren 2 och 1 arbetsdag före senast-datum. Inga mejl efter att datumet passerat.
-- Avtal som inte längre är signerade/sålda (t.ex. ånger) makuleras automatiskt.

-- ── 1. Objekt, fält och statusar ───────────────────────────────────────────
do $$
declare t record; v_id uuid;
begin
  for t in select id from tenants loop
    select id into v_id from object_definitions where tenant_id = t.id and key = 'vt_bestallning';
    if v_id is null then
      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, 'vt_bestallning', 'VT-beställning', 'VT-beställningar', 'clipboard', 'name', 63, true)
      returning id into v_id;

      insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility) values
        (v_id, t.id, 'name',             'Beställning',                 'text',      true,  '{"section":"grunduppgifter"}', 10, 'all'),
        (v_id, t.id, 'kund',             'Kund',                        'text',      false, '{"section":"grunduppgifter"}', 20, 'all'),
        (v_id, t.id, 'saljare',          'Säljare',                     'user',      false, '{"section":"grunduppgifter"}', 30, 'all'),
        (v_id, t.id, 'adress',           'Adress',                      'text',      false, '{"section":"grunduppgifter"}', 40, 'all'),
        (v_id, t.id, 'har_mobil',        'Mobilabonnemang',             'boolean',   false, '{"section":"grunduppgifter"}', 45, 'all'),
        (v_id, t.id, 'signeringsdatum',  'Signerat',                    'date',      false, '{"section":"tidplan"}', 50, 'all'),
        (v_id, t.id, 'startdatum',       'Startdatum tjänst',           'date',      false, '{"section":"tidplan"}', 60, 'all'),
        (v_id, t.id, 'mobil_startdatum', 'Startdatum mobil',            'date',      false, '{"section":"tidplan"}', 65, 'all'),
        (v_id, t.id, 'helst_datum',      'Beställ helst senast',        'date',      false, '{"section":"tidplan"}', 70, 'all'),
        (v_id, t.id, 'senast_datum',     'Beställ senast',              'date',      false, '{"section":"tidplan","_overdue":true}', 80, 'all'),
        (v_id, t.id, 'ansvarig_admin',   'Ansvarig admin',              'user',      false, '{"section":"grunduppgifter","owner_field":true}', 90, 'all'),
        (v_id, t.id, 'bestalld_av',      'Beställd av',                 'user',      false, '{"section":"ovrigt"}', 100, 'all'),
        (v_id, t.id, 'bestalld_at',      'Beställd',                    'datetime',  false, '{"section":"ovrigt"}', 110, 'all'),
        (v_id, t.id, 'lagenhet_id',      'Lägenhet (id)',               'text',      false, '{"section":"ovrigt"}', 120, 'hidden'),
        (v_id, t.id, 'kommentar',        'Kommentar',                   'long_text', false, '{"section":"ovrigt"}', 130, 'all'),
        (v_id, t.id, 'paminnelse_2d',    'Påminnelse skickad (2 arbetsdagar kvar)', 'datetime', false, '{"section":"ovrigt","readonly":true}', 140, 'hidden'),
        (v_id, t.id, 'paminnelse_1d',    'Påminnelse skickad (1 arbetsdag kvar)',   'datetime', false, '{"section":"ovrigt","readonly":true}', 141, 'hidden');

      insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order) values
        (v_id, t.id, 'oppen',     'Att beställa',  'amber', true,  false, 10),
        (v_id, t.id, 'bestalld',  'Beställd i VT', 'green', false, true,  20),
        (v_id, t.id, 'makulerad', 'Makulerad',     'slate', false, true,  30);
    end if;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select od.id, t.id, 'vt_bestallning_id', 'VT-beställning', 'text', false, '{"section":"forsaljning"}'::jsonb, 579, 'hidden'
      from object_definitions od
     where od.tenant_id = t.id and od.key = 'd2d_lagenhet'
       and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'vt_bestallning_id');
  end loop;
end $$;

-- ── 2. Datum ────────────────────────────────────────────────────────────────
/** Samma dag om det är en arbetsdag, annars närmaste arbetsdag före. */
create or replace function public.d2d_arbetsdag_pa_eller_fore(p_dag date) returns date
language plpgsql immutable as $$
declare v date := p_dag;
begin
  if v is null then return null; end if;
  while public.d2d_ar_helgdag(v) loop v := v - 1; end loop;
  return v;
end $$;

/** {helst, senast} för en beställning. Mobil 45/30 dagar, övrigt 30. */
create or replace function public.vt_datum(p_start date, p_mobil_start date, p_har_mobil boolean) returns jsonb
language sql immutable as $$
  with m as (select case when p_har_mobil then coalesce(p_mobil_start, p_start) end ms)
  select jsonb_build_object(
    'senast', public.d2d_arbetsdag_pa_eller_fore(least(p_start - 30, (select ms from m) - 30)),
    'helst',  public.d2d_arbetsdag_pa_eller_fore(least(p_start - 30, (select ms from m) - 45)))
$$;

-- ── 3. Uppgift till admin + datum ──────────────────────────────────────────
create or replace function public.vt_task_text(p jsonb, p_saljare_namn text) returns text
language sql stable as $$
  select 'BESTÄLL I VT' || E'\n\n'
    || 'Kund: ' || coalesce(p->>'kund', '—') || E'\n'
    || 'Säljare: ' || coalesce(p_saljare_namn, '—') || E'\n'
    || 'Adress: ' || coalesce(p->>'adress', '—') || E'\n'
    || 'Signerat: ' || coalesce(public.nb_fmt_date(nullif(p->>'signeringsdatum','')::date), '—') || E'\n'
    || 'Startdatum tjänst: ' || coalesce(public.nb_fmt_date(nullif(p->>'startdatum','')::date), '—') || E'\n'
    || case when (p->>'har_mobil')::boolean
            then 'Mobilabonnemang: ja, start ' || coalesce(public.nb_fmt_date(coalesce(nullif(p->>'mobil_startdatum',''), nullif(p->>'startdatum',''))::date), '—') || E'\n'
            else '' end
    || 'Beställ helst senast: ' || coalesce(public.nb_fmt_date(nullif(p->>'helst_datum','')::date), '—') || E'\n'
    || 'Beställ senast: ' || coalesce(public.nb_fmt_date(nullif(p->>'senast_datum','')::date), '—') || E'\n\n'
    || 'Mobil: avtalet ska skickas via VT senast 30 dagar före startdatum, helst 45. Övrigt: senast 30 dagar före.'
$$;

create or replace function public.vt_refresh(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r records; v_d jsonb; v_namn text; v_task uuid; v_due date;
begin
  select * into r from records where id = p_id and object_type = 'vt_bestallning';
  if not found then return; end if;
  v_d := public.vt_datum(nullif(r.data->>'startdatum','')::date, nullif(r.data->>'mobil_startdatum','')::date,
                         coalesce((r.data->>'har_mobil')::boolean, false));
  update records set data = data || jsonb_build_object('helst_datum', v_d->'helst', 'senast_datum', v_d->'senast')
   where id = p_id returning * into r;
  v_due := coalesce(nullif(r.data->>'helst_datum','')::date, nullif(r.data->>'senast_datum','')::date, current_date);

  select coalesce(full_name, email::text) into v_namn from users where id = nullif(r.data->>'saljare','')::uuid;

  if r.status = 'oppen' then
    select id into v_task from tasks where record_id = p_id and completed_at is null order by created_at limit 1;
    if v_task is null then
      insert into tasks (tenant_id, record_id, title, description, assignee_user_id, department_id,
                         priority, due_at, created_by, created_source)
      values (r.tenant_id, p_id, 'BESTÄLL I VT – ' || coalesce(r.data->>'kund', r.title),
              public.vt_task_text(r.data, v_namn), nullif(r.data->>'ansvarig_admin','')::uuid,
              (select id from departments where tenant_id = r.tenant_id and key = 'management'),
              'high', (v_due::timestamp + time '09:00') at time zone 'Europe/Stockholm', auth.uid(), 'workflow');
    else
      update tasks set title = 'BESTÄLL I VT – ' || coalesce(r.data->>'kund', r.title),
             description = public.vt_task_text(r.data, v_namn),
             assignee_user_id = nullif(r.data->>'ansvarig_admin','')::uuid,
             due_at = (v_due::timestamp + time '09:00') at time zone 'Europe/Stockholm', updated_at = now()
       where id = v_task;
    end if;
  else
    update tasks set completed_at = coalesce(completed_at, now()), completed_by = coalesce(completed_by, auth.uid())
     where record_id = p_id and completed_at is null;
  end if;
end $$;

-- ── 4. Lägenhet → beställning ──────────────────────────────────────────────
create or replace function public.d2d_vt_sync_lagenhet(p_lag uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l records; v_id uuid; v_row records; v_want boolean; v_payload jsonb; v_kund text; v_adress text;
        v_mobil boolean; v_admin uuid;
begin
  select * into l from records where id = p_lag and object_type = 'd2d_lagenhet' and deleted_at is null;
  if not found then return; end if;

  v_id := nullif(l.data->>'vt_bestallning_id', '')::uuid;
  if v_id is not null then
    select * into v_row from records where id = v_id and deleted_at is null;
    if not found then v_id := null; end if;
  end if;

  v_want := coalesce(l.data->>'scrive_signerad', '') not in ('', 'false') and l.status in ('scrive', 'sald');

  if v_want then
    v_mobil := case when jsonb_typeof(l.data->'salt_mobil') = 'array' then jsonb_array_length(l.data->'salt_mobil') > 0 else false end;
    v_kund := coalesce(nullif(trim(l.data->>'kund_namn'), ''), 'Okänd kund');
    v_adress := trim(both ' ,' from concat_ws(', ',
        nullif(trim(concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer')), ''),
        case when coalesce(l.data->>'ingang', '') <> '' then 'ingång ' || (l.data->>'ingang') end,
        case when coalesce(l.title, '') <> '' then 'lgh ' || l.title end,
        nullif(trim(concat_ws(' ', l.data->>'postnummer', l.data->>'postort')), '')));
    v_payload := jsonb_build_object(
      'kund', v_kund, 'adress', v_adress,
      'saljare', coalesce(nullif(l.data->>'saljare', ''), l.owner_user_id::text),
      'har_mobil', v_mobil,
      'startdatum', nullif(l.data->>'startdatum_tjanst', ''),
      'mobil_startdatum', case when v_mobil then nullif(l.data->>'mobil_startdatum', '') end,
      'signeringsdatum', case when l.data->>'scrive_signerad' ~ '^\d{4}-\d{2}-\d{2}' then left(l.data->>'scrive_signerad', 10) end,
      'lagenhet_id', l.id::text,
      'name', 'VT-beställning – ' || v_kund);

    if v_id is null then
      -- Standard: Lukas (mottagaren av D2D-påminnelser) som ansvarig admin.
      select u.id into v_admin from d2d_nummerbyte_notis_mottagare m join users u on u.email::text = m.epost[1]
       where m.tenant_id = l.tenant_id and u.is_active limit 1;
      insert into records (tenant_id, object_type, status, owner_user_id, data)
      values (l.tenant_id, 'vt_bestallning', 'oppen', null,
              jsonb_strip_nulls(v_payload || jsonb_build_object('ansvarig_admin', v_admin)))
      returning id into v_id;
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (l.tenant_id, v_id, 'record_created', 'VT-beställning skapad från signerat Scrive-avtal',
              jsonb_build_object('lagenhetId', l.id), auth.uid(), 'system');
      update records set data = data || jsonb_build_object('vt_bestallning_id', v_id::text) where id = l.id;
      perform public.vt_refresh(v_id);
    elsif v_row.status = 'oppen' then
      if (v_row.data - 'helst_datum' - 'senast_datum' - 'ansvarig_admin' - 'kommentar' - 'paminnelse_1d' - 'paminnelse_2d'
            - 'bestalld_av' - 'bestalld_at') is distinct from v_payload then
        update records set data = data || v_payload where id = v_id;
        perform public.vt_refresh(v_id);
      end if;
    elsif v_row.status = 'makulerad' then
      update records set status = 'oppen', data = data || v_payload where id = v_id;
      perform public.vt_refresh(v_id);
    end if;
  elsif v_id is not null and v_row.status = 'oppen' then
    update records set status = 'makulerad',
           data = data || jsonb_build_object('kommentar',
             'Makulerad automatiskt: avtalet är inte längre signerat/sålt (' || to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI') || ').')
     where id = v_id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (l.tenant_id, v_id, 'status_change', 'Makulerad – avtalet är inte längre signerat/sålt', '{}'::jsonb, auth.uid(), 'system');
    perform public.vt_refresh(v_id);
  end if;
end $$;
revoke all on function public.d2d_vt_sync_lagenhet(uuid) from public, anon, authenticated;

create or replace function public.d2d_vt_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and (new.data->>'scrive_signerad') is not distinct from (old.data->>'scrive_signerad')
     and (new.data->>'startdatum_tjanst') is not distinct from (old.data->>'startdatum_tjanst')
     and (new.data->>'mobil_startdatum') is not distinct from (old.data->>'mobil_startdatum')
     and (new.data->'salt_mobil') is not distinct from (old.data->'salt_mobil')
     and (new.data->>'kund_namn') is not distinct from (old.data->>'kund_namn')
     and (new.data->>'saljare') is not distinct from (old.data->>'saljare') then
    return new;
  end if;
  perform public.d2d_vt_sync_lagenhet(new.id);
  return new;
end $$;

create or replace trigger trg_d2d_vt_sync
  after insert or update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_vt_sync();

-- ── 5. Säljare och admin ───────────────────────────────────────────────────
/** Säljarens VT-beställningar (admin: alla): öppna + beställda/makulerade senaste 14 dagarna. */
create or replace function public.d2d_vt_mina() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := is_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'status', r.status, 'kund', r.data->>'kund', 'adress', r.data->>'adress',
      'lagenhetId', r.data->>'lagenhet_id', 'harMobil', coalesce((r.data->>'har_mobil')::boolean, false),
      'startdatum', r.data->>'startdatum', 'mobilStartdatum', r.data->>'mobil_startdatum',
      'helst', r.data->>'helst_datum', 'senast', r.data->>'senast_datum',
      'bestalldAt', r.data->>'bestalld_at',
      'bestalldAv', (select coalesce(full_name, email::text) from users where id = nullif(r.data->>'bestalld_av','')::uuid),
      'saljare', (select coalesce(full_name, email::text) from users where id = nullif(r.data->>'saljare','')::uuid),
      'mine', r.data->>'saljare' = auth.uid()::text)
      order by (r.status <> 'oppen'), nullif(r.data->>'senast_datum','')::date nulls first, r.updated_at desc)
      from records r
     where r.tenant_id = my_tenant_id() and r.object_type = 'vt_bestallning' and r.deleted_at is null
       and (v_admin or r.data->>'saljare' = auth.uid()::text)
       and (r.status = 'oppen' or r.updated_at > now() - interval '14 days')), '[]'::jsonb);
end $$;

/** Markera som beställd i VT (true) eller ångra (false). Säljaren på avtalet eller admin. */
create or replace function public.d2d_vt_markera(p_id uuid, p_bestalld boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r records;
begin
  select * into r from records where id = p_id and object_type = 'vt_bestallning' and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then raise exception 'Beställningen finns inte' using errcode = 'P0002'; end if;
  if not (is_admin() or r.data->>'saljare' = auth.uid()::text) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  if p_bestalld then
    if r.status <> 'oppen' then raise exception 'Beställningen är redan avslutad' using errcode = '22023'; end if;
    update records set status = 'bestalld',
           data = data || jsonb_build_object('bestalld_av', auth.uid(), 'bestalld_at', ce_iso(now()))
     where id = p_id;
    perform log_activity(p_id, 'status_change', 'Beställd i VT', jsonb_build_object('lagenhetId', r.data->>'lagenhet_id'));
  else
    if r.status <> 'bestalld' then raise exception 'Beställningen är inte markerad som beställd' using errcode = '22023'; end if;
    update records set status = 'oppen', data = data - 'bestalld_av' - 'bestalld_at' where id = p_id;
    perform log_activity(p_id, 'status_change', 'Ångrat: inte beställd i VT ännu', '{}'::jsonb);
  end if;
  perform public.vt_refresh(p_id);
end $$;

create or replace function public.vt_set_admin(p_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara admin kan tilldela VT-beställningar' using errcode = '42501'; end if;
  update records set data = data || jsonb_build_object('ansvarig_admin', p_user)
   where id = p_id and object_type = 'vt_bestallning' and tenant_id = my_tenant_id();
  perform public.vt_refresh(p_id);
end $$;

revoke all on function public.d2d_vt_mina() from public, anon;
revoke all on function public.d2d_vt_markera(uuid, boolean) from public, anon;
revoke all on function public.vt_set_admin(uuid, uuid) from public, anon;
grant execute on function public.d2d_vt_mina() to authenticated;
grant execute on function public.d2d_vt_markera(uuid, boolean) to authenticated;
grant execute on function public.vt_set_admin(uuid, uuid) to authenticated;

-- ── 6. Påminnelsemejl ──────────────────────────────────────────────────────
/** Öppna beställningar med 2 resp. 1 arbetsdag kvar till senast-datum (aldrig efter datumet). */
create or replace function public.d2d_vt_notis_underlag(p_tenant uuid) returns jsonb
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
        'saljareEpost', (select email::text from users where id = nullif(r.data->>'saljare','')::uuid and is_active),
        'ansvarigEpost', (select email::text from users where id = nullif(r.data->>'ansvarig_admin','')::uuid and is_active),
        'harMobil', coalesce((r.data->>'har_mobil')::boolean, false),
        'startdatum', r.data->>'startdatum', 'mobilStartdatum', r.data->>'mobil_startdatum',
        'helstDatum', r.data->>'helst_datum', 'senastDatum', r.data->>'senast_datum',
        'arbetsdagarKvar', (select count(*) from generate_series(v_idag, sen - 1, '1 day') d where not d2d_ar_helgdag(d::date))) order by sen)
      from (select r.*, nullif(r.data->>'senast_datum','')::date sen from records r
             where r.tenant_id = p_tenant and r.object_type = 'vt_bestallning' and r.status = 'oppen' and r.deleted_at is null) r
      where sen is not null and v_idag <= sen
        and ((v_idag >= d2d_arbetsdagar_fore(sen, 1) and r.data->>'paminnelse_1d' is null)
          or (v_idag >= d2d_arbetsdagar_fore(sen, 2) and r.data->>'paminnelse_2d' is null and r.data->>'paminnelse_1d' is null))
    ), '[]'::jsonb));
end $$;
revoke all on function public.d2d_vt_notis_underlag(uuid) from public, anon, authenticated;

create or replace function public.d2d_vt_notis_klar(p_rader jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare x jsonb;
begin
  for x in select * from jsonb_array_elements(coalesce(p_rader, '[]'::jsonb)) loop
    update records set data = data
      || case when x->>'typ' = '1d'
              then jsonb_build_object('paminnelse_1d', ce_iso(now()), 'paminnelse_2d', coalesce(data->>'paminnelse_2d', ce_iso(now())))
              else jsonb_build_object('paminnelse_2d', ce_iso(now())) end
     where id = (x->>'id')::uuid and object_type = 'vt_bestallning';
  end loop;
end $$;
revoke all on function public.d2d_vt_notis_klar(jsonb) from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'd2d-vt-notis') then
    perform cron.schedule('d2d-vt-notis', '10 5,11 * * *', $c$
      select net.http_post(
        url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-vt-notis',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000) as request_id;
    $c$);
  end if;
end $$;

-- ── 7. Befintliga signerade avtal som fortfarande är aktuella ─────────────
-- Bara de vars senast-datum är i dag eller senare (äldre antas redan vara beställda — 34 st
-- 12 okt), samt de utan startdatum som signerats senaste 30 dagarna.
do $$
declare l record;
begin
  for l in select id from records
            where object_type = 'd2d_lagenhet' and deleted_at is null and status in ('scrive', 'sald')
              and coalesce(data->>'scrive_signerad', '') not in ('', 'false')
              and coalesce(data->>'vt_bestallning_id', '') = ''
              and ((vt_datum(nullif(data->>'startdatum_tjanst','')::date, nullif(data->>'mobil_startdatum','')::date,
                             case when jsonb_typeof(data->'salt_mobil') = 'array' then jsonb_array_length(data->'salt_mobil') > 0 else false end)->>'senast')::date >= current_date
                   or (coalesce(data->>'startdatum_tjanst','') = '' and coalesce(data->>'mobil_startdatum','') = ''
                       and data->>'scrive_signerad' ~ '^\d{4}-\d{2}-\d{2}'
                       and left(data->>'scrive_signerad', 10)::date >= current_date - 30))
  loop
    perform public.d2d_vt_sync_lagenhet(l.id);
  end loop;
end $$;
