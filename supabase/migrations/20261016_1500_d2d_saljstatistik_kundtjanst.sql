-- D2D: topplistan räknar kundtjänstaffärer även på kundtjänst.
-- En affär som kundtjänst lämnat till en säljare (data.kundtjanst = kundtjänstens
-- användar-id) och som blivit Såld eller Scrive-signerad ger +1 på säljaren som
-- förut OCH en extra rad på kundtjänst, märkt k = true. Klienten räknar bort
-- k-raderna i teamets totalsiffror så att affären bara räknas en gång där.

create or replace function public.d2d_saljstatistik()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_tenant uuid := my_tenant_id();
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return (
    with salj as (
      select d2d_sald_tidpunkt(l.id, l.data) as t,
             coalesce(d2d_saljare_uuid(l.data), l.owner_user_id,
                      case when exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                         where ur.user_id = a.actor and r.key = 'dorrsaljare') then a.actor end) as u,
             (select pr.title from relationships lf
                join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_projekt'
                join records pr on pr.id = fp.to_record_id and pr.deleted_at is null
               where lf.from_record_id = l.id and lf.rel_type = 'd2d_lag_fastighet' limit 1) as p,
             false as s,
             d2d_saljare_uuid(jsonb_build_object('saljare', l.data->>'kundtjanst')) as kt
        from records l
        left join lateral (
          select a.actor_user_id as actor
            from activities a
           where a.record_id = l.id and a.activity_type = 'status_change' and a.metadata->>'to' = 'sald'
           order by a.occurred_at asc limit 1) a on true
       where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet'
         and l.deleted_at is null and l.status = 'sald' and coalesce(l.data->>'tillfallig', '') <> 'true'
      union all
      select av.t,
             coalesce(d2d_saljare_uuid(l.data), l.owner_user_id, av.skapad_av) as u,
             (select pr.title from relationships lf
                join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_projekt'
                join records pr on pr.id = fp.to_record_id and pr.deleted_at is null
               where lf.from_record_id = l.id and lf.rel_type = 'd2d_lag_fastighet' limit 1) as p,
             true as s,
             d2d_saljare_uuid(jsonb_build_object('saljare', l.data->>'kundtjanst')) as kt
        from records l
        join lateral (
          select coalesce(da.signerad, da.uppdaterad) as t, da.skapad_av
            from d2d_avtal da
           where da.lagenhet_id = l.id and da.status = 'signerat'
           order by coalesce(da.signerad, da.uppdaterad) desc limit 1) av on true
       where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet'
         and l.deleted_at is null and l.status = 'scrive' and coalesce(l.data->>'tillfallig', '') <> 'true'
    ),
    med_tid as (select t, u, p, s, kt from salj where t is not null and u is not null),
    -- Säljarens rad + en rad till på kundtjänst (k = true) när affären kom från kundtjänst.
    rader as (
      select t, u, p, s, false as k from med_tid
      union all
      select t, kt, p, s, true from med_tid where kt is not null and kt <> u
    )
    select jsonb_build_object(
      'salj', coalesce((select jsonb_agg(
                 case when r.k then jsonb_build_object('t', r.t, 'u', r.u, 'p', r.p, 's', r.s, 'k', true)
                      else jsonb_build_object('t', r.t, 'u', r.u, 'p', r.p, 's', r.s) end
                 order by r.t desc) from rader r), '[]'::jsonb),
      'saljare', coalesce((
        select jsonb_agg(jsonb_build_object('id', u.id, 'namn', coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)))
                         order by coalesce(nullif(u.full_name, ''), u.email::text))
          from users u
         where u.tenant_id = v_tenant and u.deleted_at is null
           and ((u.is_active and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                          where ur.user_id = u.id and r.key = 'dorrsaljare'))
                or exists (select 1 from rader s where s.u = u.id))), '[]'::jsonb),
      'utanTid', (select count(*) from salj where t is null),
      'utanSaljare', (select count(*) from salj where t is not null and u is null)
    )
  );
end $function$;
