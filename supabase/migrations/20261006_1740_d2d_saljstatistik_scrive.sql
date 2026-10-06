-- D2D: Översikten i Blitz räknar även Scrive-signeringar.
-- d2d_saljstatistik() returnerar nu i `salj` både sälj (status Såld, s = false)
-- och Scrive-signeringar (lägenhet med status "Signera med Scrive" som har ett
-- signerat avtal i d2d_avtal, s = true; tidpunkt = när avtalet signerades).
-- En lägenhet räknas bara en gång: är den Såld räknas den som sälj, inte som
-- signering. Tillfälliga lägenheter räknas inte förrän de godkänts.

create or replace function public.d2d_saljstatistik()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := my_tenant_id();
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'salj', coalesce((
      select jsonb_agg(jsonb_build_object('t', s.t, 'u', s.u, 'p', s.p, 's', s.s) order by s.t desc)
        from (
          -- Sälj (status Såld)
          select a.t,
                 coalesce(l.owner_user_id, a.actor) as u,
                 (select pr.title from relationships lf
                    join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_projekt'
                    join records pr on pr.id = fp.to_record_id and pr.deleted_at is null
                   where lf.from_record_id = l.id and lf.rel_type = 'd2d_lag_fastighet' limit 1) as p,
                 false as s
            from records l
            join lateral (
              select a.occurred_at as t, a.actor_user_id as actor
                from activities a
               where a.record_id = l.id and a.activity_type = 'status_change' and a.metadata->>'to' = 'sald'
               order by a.occurred_at desc limit 1) a on true
           where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet'
             and l.deleted_at is null and l.status = 'sald' and coalesce(l.data->>'tillfallig', '') <> 'true'
          union all
          -- Scrive-signeringar (status "Signera med Scrive" + signerat avtal)
          select av.t,
                 coalesce(l.owner_user_id, av.skapad_av) as u,
                 (select pr.title from relationships lf
                    join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_projekt'
                    join records pr on pr.id = fp.to_record_id and pr.deleted_at is null
                   where lf.from_record_id = l.id and lf.rel_type = 'd2d_lag_fastighet' limit 1) as p,
                 true as s
            from records l
            join lateral (
              select coalesce(da.signerad, da.uppdaterad) as t, da.skapad_av
                from d2d_avtal da
               where da.lagenhet_id = l.id and da.status = 'signerat'
               order by coalesce(da.signerad, da.uppdaterad) desc limit 1) av on true
           where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet'
             and l.deleted_at is null and l.status = 'scrive' and coalesce(l.data->>'tillfallig', '') <> 'true'
        ) s
       where s.u is not null), '[]'::jsonb),
    'saljare', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'namn', coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)))
                       order by coalesce(nullif(u.full_name, ''), u.email::text))
        from users u
       where u.tenant_id = v_tenant and u.is_active and u.deleted_at is null
         and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                      where ur.user_id = u.id and r.key = 'dorrsaljare')), '[]'::jsonb),
    'utanTid', (select count(*) from records l
                 where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
                   and l.status = 'sald' and coalesce(l.data->>'tillfallig', '') <> 'true'
                   and not exists (select 1 from activities a where a.record_id = l.id
                                    and a.activity_type = 'status_change' and a.metadata->>'to' = 'sald'))
  );
end $$;
