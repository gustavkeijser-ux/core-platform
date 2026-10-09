-- D2D: planeringsverktyget visar alla säljstatusar per projekt och per fastighet.
-- d2d_planering_status(null)      → alla projekt med antal lägenheter per status
-- d2d_planering_status(<projekt>) → projektets summering + varje fastighet med antal per status
-- Statusarna (nyckel, etikett, färg, ordning) skickas med så att UI:t följer status_definitions.
create or replace function public.d2d_planering_status(p_projekt uuid default null)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_t uuid := my_tenant_id(); v_stat jsonb; v_res jsonb;
begin
  if not (can_do('d2d_projekt', 'read') and can_do('d2d_lagenhet', 'read')) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('key', sd.key, 'label', sd.label, 'color', sd.color) order by sd.sort_order), '[]'::jsonb)
    into v_stat
    from status_definitions sd join object_definitions od on od.id = sd.object_id
   where od.tenant_id = v_t and od.key = 'd2d_lagenhet';

  with fast as (
    select f.id fast_id, f.title fast_title, f.status fast_status, f.data fast_data, p.id proj_id
      from records p
      join relationships rp on rp.to_record_id = p.id and rp.rel_type = 'd2d_fast_projekt'
      join records f on f.id = rp.from_record_id and f.deleted_at is null and f.object_type = 'd2d_fastighet'
     where p.tenant_id = v_t and p.object_type = 'd2d_projekt' and p.deleted_at is null
       and (p_projekt is null or p.id = p_projekt)
  ), lag as (
    select fa.proj_id, fa.fast_id, l.status, nullif(l.data->>'saljare', '') saljare
      from fast fa
      join relationships rl on rl.to_record_id = fa.fast_id and rl.rel_type = 'd2d_lag_fastighet'
      join records l on l.id = rl.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
  )
  select case when p_projekt is null then
    jsonb_build_object('statusar', v_stat, 'projekt', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'title', p.title, 'status', p.status, 'updatedAt', p.updated_at,
          'fastigheter', (select count(*) from fast where proj_id = p.id),
          'lagenheter', (select count(*) from lag where proj_id = p.id),
          'saljare', (select count(distinct saljare) from lag where proj_id = p.id),
          'antal', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                      from (select coalesce(status, 'ej_knackad') status, count(*) n from lag where proj_id = p.id group by 1) s))
        order by p.updated_at desc)
        from records p
       where p.tenant_id = v_t and p.object_type = 'd2d_projekt' and p.deleted_at is null), '[]'::jsonb))
  else
    jsonb_build_object('statusar', v_stat,
      'projekt', jsonb_build_object(
          'lagenheter', (select count(*) from lag),
          'saljare', (select count(distinct saljare) from lag),
          'antal', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                      from (select coalesce(status, 'ej_knackad') status, count(*) n from lag group by 1) s)),
      'fastigheter', coalesce((
        select jsonb_object_agg(fa.fast_id, jsonb_build_object(
            'lagenheter', (select count(*) from lag where fast_id = fa.fast_id),
            'saljare', (select count(distinct saljare) from lag where fast_id = fa.fast_id),
            'antal', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                        from (select coalesce(status, 'ej_knackad') status, count(*) n from lag where fast_id = fa.fast_id group by 1) s)))
          from fast fa), '{}'::jsonb))
  end into v_res;
  return v_res;
end $function$;
revoke all on function public.d2d_planering_status(uuid) from public, anon;
grant execute on function public.d2d_planering_status(uuid) to authenticated;
