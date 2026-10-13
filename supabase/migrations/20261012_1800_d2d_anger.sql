-- D2D: Ånger — kund som signerat/köpt men ångrat sin tjänst.
--
-- * Ny status "anger" (Ånger) på d2d_lagenhet. Tjänsterna (salt_*) ligger kvar, så
--   statistik på vad som initialt såldes finns kvar; ångern loggas på adressen.
-- * Får markeras på Såld / Signera med Scrive av säljaren som sålde, kundtjänst och admin.
--   Bara admin kan ta bort en ånger. Trigger d2d_anger_kontroll fyller i och loggar.
--   Fält: anger_datum, anger_kalla (kund/telia/annan), anger_kommentar, anger_registrerad,
--   anger_av, anger_status_fore.
-- * Lön: ånger i samma löneperiod som affären → affären räknas inte. Ånger efter att
--   perioden gått → affären står kvar i sin period och dras av (minus pinnar) i den
--   period ångern registrerades. Scrive-signerade (ej Sålda) som ångras räknas bara bort.
-- * Telia-underlag (VT-filen, kolumnen orderstatus): d2d_telia_vt_import.
--   Cancelled → ånger (källa Telia). Open/Complete → orderstatus sparas på adressen och
--   en öppen VT-beställning markeras som beställd. Matchning på personnummer (10 sista
--   siffrorna), annars gatuadress + nummer + lägenhetsnummer + postnummer.
-- * Statistik: d2d_anger_statistik (per säljare, lista).

-- ── 1. Status och fält ─────────────────────────────────────────────────────
do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'd2d_lagenhet';
    if v_obj is null then continue; end if;
    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    select v_obj, t.id, 'anger', 'Ånger', 'red', false, false,
           coalesce((select sort_order from status_definitions where object_id = v_obj and key = 'scrive'), 90) + 1
     where not exists (select 1 from status_definitions where object_id = v_obj and key = 'anger');

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select v_obj, t.id, v.key, v.label, v.typ, false, v.opts::jsonb, v.sort, v.vis
      from (values
        ('anger_datum',        'Ånger – datum',                'date',      '{"section":"forsaljning"}', 590, 'all'),
        ('anger_kalla',        'Ånger – källa',                'select',    '{"section":"forsaljning","choices":[{"key":"kund","label":"Kunden hörde av sig"},{"key":"telia","label":"Telia-underlag"},{"key":"annan","label":"Annat"}]}', 591, 'all'),
        ('anger_kommentar',    'Ånger – kommentar',            'long_text', '{"section":"forsaljning"}', 592, 'all'),
        ('anger_registrerad',  'Ånger – registrerad',          'datetime',  '{"section":"forsaljning","readonly":true}', 593, 'hidden'),
        ('anger_av',           'Ånger – registrerad av',       'user',      '{"section":"forsaljning","readonly":true}', 594, 'hidden'),
        ('anger_status_fore',  'Ånger – status före',          'text',      '{"section":"forsaljning","readonly":true}', 595, 'hidden'),
        ('vt_ordernummer',     'Telia – ordernummer',          'text',      '{"section":"forsaljning","readonly":true}', 596, 'all'),
        ('vt_orderstatus',     'Telia – orderstatus',          'text',      '{"section":"forsaljning","readonly":true}', 597, 'all'),
        ('vt_order_uppdaterad','Telia – order uppdaterad',     'datetime',  '{"section":"forsaljning","readonly":true}', 598, 'hidden')
      ) v(key, label, typ, opts, sort, vis)
     where not exists (select 1 from field_definitions f where f.object_id = v_obj and f.key = v.key);
  end loop;
end $$;

-- ── 2. Kontroll + loggning vid statusbyte till/från Ånger ──────────────────
create or replace function public.d2d_anger_kontroll()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_uid uuid := auth.uid(); v_ok boolean;
begin
  if new.status is not distinct from old.status then return new; end if;

  if new.status = 'anger' then
    if old.status not in ('sald', 'scrive') then
      raise exception 'Ånger kan bara markeras på en såld eller signerad adress.' using errcode = '22023';
    end if;
    if v_uid is not null then
      v_ok := is_admin()
           or nullif(old.data->>'saljare', '') = v_uid::text
           or exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                       where ur.user_id = v_uid and r.key in ('kundtjanst', 'kundtjanst_leverans', 'ledning'));
      if not v_ok then
        raise exception 'Bara säljaren som sålde, kundtjänst eller admin kan markera ånger.' using errcode = '42501';
      end if;
    end if;
    new.data := new.data || jsonb_build_object(
      'anger_status_fore', old.status,
      'anger_registrerad', ce_iso(now()),
      'anger_av', v_uid,
      'anger_datum', coalesce(nullif(new.data->>'anger_datum', ''), (now() at time zone 'Europe/Stockholm')::date::text),
      'anger_kalla', coalesce(nullif(new.data->>'anger_kalla', ''), 'kund'));
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (new.tenant_id, new.id, 'status_change',
            'Ånger registrerad (' || case new.data->>'anger_kalla' when 'telia' then 'Telia-underlag' when 'annan' then 'annat' else 'kunden hörde av sig' end
              || ', ' || (new.data->>'anger_datum') || ')'
              || coalesce(': ' || nullif(btrim(new.data->>'anger_kommentar'), ''), ''),
            jsonb_build_object('from', old.status, 'to', 'anger', 'kalla', new.data->>'anger_kalla',
                               'datum', new.data->>'anger_datum', 'saljare', old.data->>'saljare'),
            v_uid, case when v_uid is null then 'system' else 'user' end);
  elsif old.status = 'anger' then
    if v_uid is not null and not is_admin() then
      raise exception 'Bara admin kan ta bort en ånger.' using errcode = '42501';
    end if;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    -- Metadata 'till' (inte 'to'): annars skulle lönen tro att adressen såldes nu.
    values (new.tenant_id, new.id, 'status_change', 'Ånger borttagen — status ' || coalesce(new.status, '—'),
            jsonb_build_object('from', 'anger', 'till', new.status, 'tidigare', jsonb_build_object(
              'datum', old.data->>'anger_datum', 'kalla', old.data->>'anger_kalla', 'registrerad', old.data->>'anger_registrerad')),
            v_uid, case when v_uid is null then 'system' else 'user' end);
    new.data := new.data - 'anger_datum' - 'anger_kalla' - 'anger_kommentar' - 'anger_registrerad' - 'anger_av' - 'anger_status_fore';
  end if;
  return new;
end $function$;

-- Körs före låset (bokstavsordning: d2d_anger < d2d_lag).
create or replace trigger trg_d2d_anger_kontroll
  before update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_anger_kontroll();

/** Markera ånger (säljaren i D2D-sälj, kundtjänst, admin). */
create or replace function public.d2d_markera_anger(p_lag uuid, p_kalla text default 'kund', p_datum date default null, p_kommentar text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r records;
begin
  select * into r from records where id = p_lag and object_type = 'd2d_lagenhet' and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then raise exception 'Adressen finns inte' using errcode = 'P0002'; end if;
  update records set status = 'anger',
         data = data || jsonb_strip_nulls(jsonb_build_object(
           'anger_kalla', case when p_kalla in ('kund', 'telia', 'annan') then p_kalla else 'kund' end,
           'anger_datum', coalesce(p_datum, (now() at time zone 'Europe/Stockholm')::date),
           'anger_kommentar', nullif(btrim(coalesce(p_kommentar, '')), '')))
   where id = p_lag
  returning * into r;
  return jsonb_build_object('status', r.status, 'data', r.data);
end $function$;

/** Ta bort en ånger (admin): tillbaka till statusen före. */
create or replace function public.d2d_ta_bort_anger(p_lag uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r records;
begin
  if not is_admin() then raise exception 'Bara admin kan ta bort en ånger.' using errcode = '42501'; end if;
  select * into r from records where id = p_lag and object_type = 'd2d_lagenhet' and tenant_id = my_tenant_id() and status = 'anger';
  if not found then raise exception 'Adressen har ingen ånger' using errcode = 'P0002'; end if;
  update records set status = coalesce(nullif(r.data->>'anger_status_fore', ''), 'sald') where id = p_lag returning * into r;
  return jsonb_build_object('status', r.status, 'data', r.data);
end $function$;

revoke all on function public.d2d_markera_anger(uuid, text, date, text) from public, anon;
revoke all on function public.d2d_ta_bort_anger(uuid) from public, anon;
grant execute on function public.d2d_markera_anger(uuid, text, date, text) to authenticated;
grant execute on function public.d2d_ta_bort_anger(uuid) to authenticated;

-- ── 3. Lön ─────────────────────────────────────────────────────────────────
/** Löneperiodens nyckel för en tidpunkt (månader före första perioden räknas till den). */
create or replace function public.d2d_lon_period_nyckel(p_modell jsonb, p_t timestamptz)
returns date language sql stable as $$
  select greatest(date_trunc('month', p_t at time zone 'Europe/Stockholm')::date,
                  coalesce(date_trunc('month', nullif(p_modell->>'forstaPeriodTill', '')::date)::date, '2000-01-01'::date))
$$;

create or replace function public.d2d_lon_affarer(p_tenant uuid, p_fran timestamptz, p_till timestamptz)
 returns table(lagenhet_id uuid, saljare uuid, t timestamptz, kalla text, d jsonb)
 language sql stable security definer set search_path to 'public'
as $function$
  with m as (select d2d_lonemodell_for(p_tenant) m),
  l as (
    select l.id, l.status, l.data, l.owner_user_id,
           case when l.status = 'anger' then nullif(l.data->>'anger_status_fore', '') else l.status end st,
           case when l.data->>'saljare' ~* '^[0-9a-f-]{36}$' then (l.data->>'saljare')::uuid end ds
      from records l
     where l.tenant_id = p_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and l.status in ('sald', 'scrive', 'anger') and coalesce(l.data->>'tillfallig', '') <> 'true'
  ),
  x as (
    select l.id, coalesce(l.ds, l.owner_user_id) u, l.data, l.status = 'anger' ar_anger,
           nullif(l.data->>'anger_registrerad', '')::timestamptz ta,
           case when l.st = 'sald' then 'sald'
                when sig.t is not null then 'signerat'
                else 'vantar' end kalla,
           case when l.st = 'sald' then coalesce(
                  (select a.occurred_at from activities a where a.record_id = l.id and a.activity_type = 'status_change'
                      and a.metadata->>'to' = 'sald' order by a.occurred_at desc limit 1),
                  (l.data->>'senast_kontakt')::timestamptz)
                when sig.t is not null then sig.t
                else coalesce((l.data->>'senast_kontakt')::timestamptz,
                              (select max(da.skapad) from d2d_avtal da where da.lagenhet_id = l.id)) end t
      from l
      left join lateral (select coalesce(da.signerad, da.uppdaterad) t from d2d_avtal da
                          where da.lagenhet_id = l.id and da.status = 'signerat'
                          order by 1 desc limit 1) sig on true
     where l.st = 'sald' or sig.t is not null
        or exists (select 1 from d2d_avtal da where da.lagenhet_id = l.id and da.status in ('skapas', 'vantar'))
  ),
  -- Ångrade Sålda vars ånger kom i en senare löneperiod och som faktiskt löneräknades.
  sen_anger as (
    select x.* from x, m
     where x.ar_anger and x.kalla = 'sald' and x.ta is not null and x.u is not null and x.t is not null
       and d2d_lon_period_nyckel(m.m, x.ta) > d2d_lon_period_nyckel(m.m, x.t)
       and (x.t at time zone 'Europe/Stockholm')::date >= coalesce(nullif(m.m->>'startdatum', '')::date, '2000-01-01'::date)
  )
  select id, u, t, kalla, data from x
   where not ar_anger and u is not null and t >= p_fran and t < p_till
  union all
  select id, u, t, kalla, data from sen_anger where t >= p_fran and t < p_till
  union all
  select id, u, ta, 'anger', data from sen_anger where ta >= p_fran and ta < p_till
$function$;

do $$
declare src text; a text; b text;
begin
  src := pg_get_functiondef('public.d2d_lon_manad(uuid,date,boolean)'::regprocedure);
  if position('angerPinnar' in src) > 0 then return; end if;

  a := 'af.kalla in (''sald'', ''signerat'')';
  if position(a in src) = 0 then raise exception 'd2d_lon_manad: hittar inte kalla-filtret'; end if;
  src := replace(src, a, 'af.kalla in (''sald'', ''signerat'', ''anger'')');

  a := 'coalesce(sum(a.p) filter (where a.kalla = ''sald''), 0) pinnar,';
  if position(a in src) = 0 then raise exception 'd2d_lon_manad: hittar inte pinnar'; end if;
  src := replace(src, a, 'coalesce(sum(a.p) filter (where a.kalla = ''sald''), 0) - coalesce(sum(a.p) filter (where a.kalla = ''anger''), 0) pinnar,'
    || E'\n           coalesce(sum(a.p) filter (where a.kalla = ''anger''), 0) anger_pinnar,'
    || E'\n           count(a.lagenhet_id) filter (where a.kalla = ''anger'') anger,');

  a := '''scrive'', round(rad.vantar, 1), ''affarerScrive'', rad.affarer_vantar)';
  if position(a in src) = 0 then raise exception 'd2d_lon_manad: hittar inte scrive-utdata'; end if;
  src := replace(src, a, '''scrive'', round(rad.vantar, 1), ''affarerScrive'', rad.affarer_vantar,'
    || ' ''anger'', rad.anger, ''angerPinnar'', round(rad.anger_pinnar, 1))');
  execute src;
end $$;

-- ── 4. Statistik ───────────────────────────────────────────────────────────
/** Ånger per säljare + lista. Admin/kundtjänst/ledning ser alla, övriga sina egna.
 *  "salda" = alla initialt sålda/signerade (inkl. de som sedan ångrats). Datumfilter på ångerdatum
 *  resp. senast kontakt. */
create or replace function public.d2d_anger_statistik(p_fran date default null, p_till date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_t uuid := my_tenant_id(); v_alla boolean; v_res jsonb;
begin
  if not can_do('d2d_lagenhet', 'read') then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  v_alla := is_admin() or exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                   where ur.user_id = auth.uid() and r.key in ('kundtjanst', 'kundtjanst_leverans', 'ledning'));
    with l as (
      select l.id, l.status, l.data, l.title, nullif(l.data->>'saljare', '') s,
             coalesce(nullif(l.data->>'anger_datum', '')::date, (l.data->>'anger_registrerad')::timestamptz::date) ad
        from records l
       where l.tenant_id = v_t and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
         and l.status in ('sald', 'scrive', 'anger') and coalesce(l.data->>'tillfallig', '') <> 'true'
         and (v_alla or l.data->>'saljare' = auth.uid()::text)
    ),
    sald as (select * from l where (p_fran is null or coalesce((data->>'senast_kontakt')::timestamptz::date, ad) >= p_fran)
                               and (p_till is null or coalesce((data->>'senast_kontakt')::timestamptz::date, ad) <= p_till)),
    ang as (select * from l where status = 'anger' and (p_fran is null or ad >= p_fran) and (p_till is null or ad <= p_till))
    select jsonb_build_object(
      'alla', v_alla,
      'antal', (select count(*) from ang),
      'salda', (select count(*) from sald),
      'perSaljare', coalesce((select jsonb_agg(jsonb_build_object(
            'id', z.s, 'namn', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = z.s),
            'anger', z.anger, 'kund', z.kund, 'telia', z.telia, 'salda', z.salda) order by z.anger desc, z.salda desc)
          from (select coalesce(a.s, b.s) s, coalesce(a.n, 0) anger, coalesce(a.kund, 0) kund, coalesce(a.telia, 0) telia, coalesce(b.n, 0) salda
                  from (select s, count(*) n, count(*) filter (where data->>'anger_kalla' = 'kund') kund,
                               count(*) filter (where data->>'anger_kalla' = 'telia') telia from ang where s is not null group by 1) a
                  full join (select s, count(*) n from sald where s is not null group by 1) b on b.s = a.s) z), '[]'::jsonb),
      'lista', coalesce((select jsonb_agg(jsonb_build_object(
            'id', id, 'kund', data->>'kund_namn',
            'adress', concat_ws(' ', data->>'gatunamn', data->>'gatunummer') || coalesce(', lgh ' || nullif(title, ''), ''),
            'ort', data->>'postort', 'datum', ad, 'kalla', data->>'anger_kalla', 'kommentar', data->>'anger_kommentar',
            'statusFore', data->>'anger_status_fore',
            'saljare', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = s),
            'mine', s = auth.uid()::text) order by ad desc nulls last)
          from ang), '[]'::jsonb)) into v_res;
  return v_res;
end $function$;
revoke all on function public.d2d_anger_statistik(date, date) from public, anon;
grant execute on function public.d2d_anger_statistik(date, date) to authenticated;

-- ── 5. VT-beställningen makuleras med rätt text vid ånger ─────────────────
do $$
declare src text; a text := '''Makulerad automatiskt: avtalet är inte längre signerat/sålt (''';
begin
  src := pg_get_functiondef('public.d2d_vt_sync_lagenhet(uuid)'::regprocedure);
  if position('Kunden har ångrat' in src) > 0 then return; end if;
  if position(a in src) = 0 then raise exception 'd2d_vt_sync_lagenhet: hittar inte texten'; end if;
  execute replace(src, a, 'case when l.status = ''anger'' then ''Makulerad automatiskt: Kunden har ångrat ('' else ''Makulerad automatiskt: avtalet är inte längre signerat/sålt ('' end');
end $$;

-- ── 6. Telia-underlag (VT-filen) ───────────────────────────────────────────
/** p_rader = [{rad, order, status, persnr, adress, gatnummer, uppgang, lgh, postnr, uppdaterad}].
 *  p_kor = false: förhandsgranska. true: genomför. Admin/kundtjänst. */
create or replace function public.d2d_telia_vt_import(p_rader jsonb, p_kor boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_t uuid := my_tenant_id(); x jsonb; v_res jsonb := '[]'::jsonb; v_ids uuid[]; v_lag records; v_atg text;
        v_pnr text; v_st text; v_vt uuid; v_upd timestamptz; v_n int;
begin
  if not (is_admin() or exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                 where ur.user_id = auth.uid() and r.key in ('kundtjanst', 'kundtjanst_leverans', 'ledning'))) then
    raise exception 'Bara admin och kundtjänst kan läsa in Telia-underlag' using errcode = '42501';
  end if;

  for x in select * from jsonb_array_elements(coalesce(p_rader, '[]'::jsonb)) loop
    v_st := lower(btrim(coalesce(x->>'status', '')));
    v_pnr := right(regexp_replace(coalesce(x->>'persnr', ''), '\D', '', 'g'), 10);
    v_upd := case when x->>'uppdaterad' ~ '^\d{4}-\d{2}-\d{2}' then (x->>'uppdaterad')::timestamptz end;
    v_ids := null;

    -- 1. Personnummer
    if length(v_pnr) = 10 then
      select array_agg(id) into v_ids from records
       where tenant_id = v_t and object_type = 'd2d_lagenhet' and deleted_at is null
         and status in ('sald', 'scrive', 'anger')
         and right(regexp_replace(coalesce(data->>'personnummer', ''), '\D', '', 'g'), 10) = v_pnr;
    end if;
    -- 2. Adress + lägenhetsnummer + postnummer
    if coalesce(cardinality(v_ids), 0) = 0 and coalesce(x->>'adress', '') <> '' and coalesce(x->>'lgh', '') <> '' then
      select array_agg(id) into v_ids from records
       where tenant_id = v_t and object_type = 'd2d_lagenhet' and deleted_at is null
         and status in ('sald', 'scrive', 'anger')
         and upper(btrim(data->>'gatunamn')) = upper(btrim(x->>'adress'))
         and regexp_replace(coalesce(data->>'gatunummer', ''), '\s', '', 'g') = regexp_replace(coalesce(x->>'gatnummer', ''), '\s', '', 'g')
         and regexp_replace(coalesce(title, data->>'name', ''), '\D', '', 'g') = regexp_replace(x->>'lgh', '\D', '', 'g')
         and (coalesce(x->>'postnr', '') = '' or regexp_replace(coalesce(data->>'postnummer', ''), '\D', '', 'g') = regexp_replace(x->>'postnr', '\D', '', 'g'));
    end if;

    v_n := coalesce(cardinality(v_ids), 0);
    v_lag := null;
    if v_n = 1 then select * into v_lag from records where id = v_ids[1]; end if;

    v_atg := case
      when v_n = 0 then 'ingen_traff'
      when v_n > 1 then 'flera_traffar'
      when v_st in ('cancelled', 'canceled') and v_lag.status = 'anger' then 'redan_anger'
      when v_st in ('cancelled', 'canceled') then 'anger'
      when v_st in ('open', 'complete', 'completed') and v_lag.status = 'anger' then 'konflikt'
      when v_st in ('open', 'complete', 'completed') then 'orderlagd'
      else 'okand_status' end;

    if p_kor and v_n = 1 then
      -- Telias orderuppgifter sparas alltid på adressen.
      update records set data = data || jsonb_strip_nulls(jsonb_build_object(
               'vt_ordernummer', nullif(x->>'order', ''), 'vt_orderstatus', nullif(x->>'status', ''),
               'vt_order_uppdaterad', case when v_upd is not null then ce_iso(v_upd) end))
       where id = v_lag.id;
      if v_atg = 'anger' then
        update records set status = 'anger',
               data = data || jsonb_build_object('anger_kalla', 'telia',
                 'anger_datum', coalesce((v_upd at time zone 'Europe/Stockholm')::date, (now() at time zone 'Europe/Stockholm')::date),
                 'anger_kommentar', 'Avbruten enligt Telia-underlag' || coalesce(' (order ' || nullif(x->>'order', '') || ')', ''))
         where id = v_lag.id;
      elsif v_atg = 'orderlagd' then
        v_vt := nullif(v_lag.data->>'vt_bestallning_id', '')::uuid;
        if v_vt is not null and exists (select 1 from records where id = v_vt and status = 'oppen') then
          update records set status = 'bestalld',
                 data = data || jsonb_build_object('bestalld_av', auth.uid(), 'bestalld_at', ce_iso(now()),
                   'kommentar', 'Beställd enligt Telia-underlag (' || coalesce(x->>'status', '') || coalesce(', order ' || nullif(x->>'order', ''), '') || ').')
           where id = v_vt;
          perform log_activity(v_vt, 'status_change', 'Beställd i VT enligt Telia-underlag', jsonb_build_object('order', x->>'order'));
          perform public.vt_refresh(v_vt);
        end if;
      end if;
    end if;

    v_res := v_res || jsonb_build_array(jsonb_build_object(
      'rad', x->'rad', 'order', x->>'order', 'status', x->>'status', 'atgard', v_atg, 'traffar', v_n,
      'lagenhetId', v_lag.id, 'statusNu', v_lag.status,
      'kund', v_lag.data->>'kund_namn',
      'adress', case when v_lag.id is not null then concat_ws(' ', v_lag.data->>'gatunamn', v_lag.data->>'gatunummer') || coalesce(', lgh ' || nullif(v_lag.title, ''), '') end,
      'saljare', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = v_lag.data->>'saljare'),
      'filAdress', concat_ws(' ', x->>'adress', x->>'gatnummer', x->>'uppgang') || coalesce(', lgh ' || nullif(x->>'lgh', ''), '')));
  end loop;
  return jsonb_build_object('kord', p_kor, 'rader', v_res);
end $function$;
revoke all on function public.d2d_telia_vt_import(jsonb, boolean) from public, anon;
grant execute on function public.d2d_telia_vt_import(jsonb, boolean) to authenticated;
