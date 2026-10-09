-- Ärenden: mejl för felanmälningar (steg 4). Edge function felanmalan-notis körs var 5:e minut (pg_cron)
-- och skickar via Microsoft Graph från ärendebrevlådan (sparas inte i Skickat, så mail-sync rör dem inte):
--   * Ny felanmälan        → ansvarig + bevakare (en gång per ärende, data.notis_ny).
--   * Passerad SLA         → ansvarig + bevakare (en gång per deadline, data.notis_sla_for = deadlinen;
--                            flyttas deadlinen, t.ex. efter "Väntar på Telia", kan en ny påminnelse gå).
--   * Ändringar            → bevakare (status- och fältändringar sedan förra körningen, ej egna ändringar).
--   * Veckomejl måndagar   → bevakare: alla öppna felanmälningar per D2D-projekt (efter kl. 07, en gång per vecka).
-- Underlaget räknas fram här (felanmalan_notis_underlag) och markeras efter utskick (felanmalan_notis_klar);
-- båda körs bara av service role.

alter table public.case_felanmalan_installningar add column if not exists veckomejl_skickad date;
alter table public.case_felanmalan_installningar add column if not exists notis_senast timestamptz;

create or replace function public.felanmalan_notis_underlag(p_tenant uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_inst case_felanmalan_installningar; v_nu timestamptz := now(); v_lokal timestamp := now() at time zone 'Europe/Stockholm';
        v_bev text[]; v_res jsonb;
begin
  select * into v_inst from case_felanmalan_installningar where tenant_id = p_tenant;
  if not found then return null; end if;

  -- Bevakarnas e-post (standardbevakarna, för veckomejlet)
  select coalesce(array_agg(distinct u.email::text), array[]::text[]) into v_bev
    from users u where u.id = any(v_inst.bevakare) and u.is_active and u.email is not null;

  with fel as (
    select c.*,
           (select label from case_categories where tenant_id = p_tenant and key = c.data->>'category') kat,
           (select label from case_categories where tenant_id = p_tenant and key = c.data->>'subcategory') sub,
           coalesce(case_status_label(p_tenant, c.status), c.status) statuslabel,
           (select coalesce(full_name, email::text) from users where id = c.owner_user_id) ansvarig,
           (select coalesce(full_name, email::text) from users where id::text = c.data->>'anmald_av') anmald,
           (select p.title from relationships r join records p on p.id = r.to_record_id
             where r.from_record_id = c.id and r.rel_type = 'case_d2d_projekt' limit 1) projekt,
           (select coalesce(array_agg(distinct u.email::text), array[]::text[]) from users u
             where u.is_active and u.email is not null
               and (u.id = c.owner_user_id or u.id::text in (select jsonb_array_elements_text(coalesce(c.data->'bevakare', '[]'::jsonb))))) mottagare
      from records c
     where c.tenant_id = p_tenant and c.object_type = 'case' and c.deleted_at is null and c.data->>'channel' = 'd2d'
  ), kort as (
    select f.id, jsonb_build_object(
      'id', f.id, 'nr', f.data->>'case_number', 'rubrik', f.title, 'kategori', f.kat, 'underkategori', f.sub,
      'plats', coalesce(f.data->>'lagenhet_namn', f.data->>'fastighet_namn'), 'projekt', f.projekt,
      'status', f.status, 'statusLabel', f.statuslabel, 'prioritet', coalesce(f.data->>'priority', 'normal'),
      'ansvarig', f.ansvarig, 'anmaldAv', f.anmald, 'telia', f.data->>'telia_arendenr',
      'deadline', f.data->>'resolution_due_at', 'skapad', f.created_at,
      'dagar', floor(extract(epoch from v_nu - f.created_at) / 86400),
      'beskrivning', f.data->>'beskrivning') k
      from fel f
  )
  select jsonb_build_object(
    'nya', coalesce((select jsonb_agg((select k from kort where kort.id = f.id) || jsonb_build_object('mottagare', to_jsonb(f.mottagare)))
                       from fel f where f.data->>'notis_ny' is null and f.created_at > v_nu - interval '2 days'
                        and cardinality(f.mottagare) > 0), '[]'::jsonb),
    'sla', coalesce((select jsonb_agg((select k from kort where kort.id = f.id) || jsonb_build_object('mottagare', to_jsonb(f.mottagare)))
                       from fel f where f.status not in ('resolved', 'closed', 'waiting_telia')
                        and nullif(f.data->>'resolution_due_at', '')::timestamptz < v_nu
                        and coalesce(f.data->>'notis_sla_for', '') <> f.data->>'resolution_due_at'
                        and cardinality(f.mottagare) > 0), '[]'::jsonb),
    'andringar', case when v_inst.notis_senast is null then '[]'::jsonb else coalesce((
        select jsonb_agg((select k from kort where kort.id = q.record_id)
                 || jsonb_build_object('handelser', q.handelser,
                      -- Bevakare som själv gjort alla ändringarna får inget mejl.
                      'mottagare', to_jsonb(array(select u.email::text from users u
                         where u.is_active and u.email is not null
                           and u.id::text in (select jsonb_array_elements_text(coalesce(f.data->'bevakare', '[]'::jsonb)))
                           and q.aktorer is distinct from array[u.id]))))
          from (select a.record_id,
                       jsonb_agg(jsonb_build_object('text', a.body,
                         'vem', (select coalesce(full_name, email::text) from users where id = a.actor_user_id),
                         'nar', a.occurred_at) order by a.occurred_at) handelser,
                       array_agg(distinct a.actor_user_id) filter (where a.actor_user_id is not null) aktorer
                  from activities a join fel f2 on f2.id = a.record_id
                 where a.activity_type in ('status_change', 'field_change')
                   and a.occurred_at > v_inst.notis_senast and a.occurred_at <= v_nu
                   and a.occurred_at > f2.created_at + interval '1 minute'
                 group by a.record_id) q
          join fel f on f.id = q.record_id), '[]'::jsonb) end,
    'vecka', case when extract(isodow from v_lokal) = 1 and extract(hour from v_lokal) >= 7
                   and (v_inst.veckomejl_skickad is null or v_inst.veckomejl_skickad < v_lokal::date)
                   and cardinality(v_bev) > 0
              then jsonb_build_object('mottagare', to_jsonb(v_bev), 'lista', coalesce((
                     select jsonb_agg(kort.k order by kort.k->>'projekt' nulls last, (kort.k->>'skapad'))
                       from kort join fel f on f.id = kort.id where f.status not in ('resolved', 'closed')), '[]'::jsonb))
              end,
    'nu', v_nu,
    'svaraTill', to_jsonb(v_bev)
  ) into v_res;
  return v_res;
end $function$;
revoke all on function public.felanmalan_notis_underlag(uuid) from public, anon, authenticated;

create or replace function public.felanmalan_notis_klar(p_tenant uuid, p_nya uuid[], p_sla jsonb, p_nu timestamptz, p_vecka boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare s jsonb;
begin
  update records set data = data || jsonb_build_object('notis_ny', public.ce_iso(now()))
   where tenant_id = p_tenant and id = any(coalesce(p_nya, array[]::uuid[]));
  for s in select * from jsonb_array_elements(coalesce(p_sla, '[]'::jsonb)) loop
    update records set data = data || jsonb_build_object('notis_sla_for', s->>'deadline')
     where tenant_id = p_tenant and id = (s->>'id')::uuid;
  end loop;
  update case_felanmalan_installningar
     set notis_senast = coalesce(p_nu, now()),
         veckomejl_skickad = case when p_vecka then (now() at time zone 'Europe/Stockholm')::date else veckomejl_skickad end,
         updated_at = now()
   where tenant_id = p_tenant;
end $function$;
revoke all on function public.felanmalan_notis_klar(uuid, uuid[], jsonb, timestamptz, boolean) from public, anon, authenticated;

-- Fälten som markerar utskick (dolda) måste finnas för validate_record_data.
do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'case';
    if v_obj is null then continue; end if;
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility) values
      (v_obj, t.id, 'notis_ny',      'Mejl skickat (ny felanmälan)', 'datetime', false, '{"section":"sla","readonly":true}', 69, 'hidden'),
      (v_obj, t.id, 'notis_sla_for', 'SLA-påminnelse skickad för',   'text',     false, '{"section":"sla","readonly":true}', 70, 'hidden')
    on conflict (object_id, key) do nothing;
  end loop;
end $$;

-- Var 5:e minut
select cron.schedule('felanmalan-notis', '*/5 * * * *', $c$
  select net.http_post(
    url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/felanmalan-notis',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000) as request_id;
$c$);
