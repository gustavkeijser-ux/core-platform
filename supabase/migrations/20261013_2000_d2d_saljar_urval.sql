-- =====================================================================
--  20261013_2000 — D2D-sälj: projekt- och fastighetslistan i ett anrop
--
--  Säljarvyn hämtade alla lägenhet→fastighet-relationer sida för sida
--  (RLS kontrollerar båda posterna per rad) och sedan fastigheterna i
--  omgångar. Med ~10 000 lägenheter tog det många sekunder. Nu ett
--  anrop som returnerar fastigheterna (utan stora fält), deras projekt
--  och antal lägenheter, samt projekten.
--  Fastigheter med minst en synlig lägenhet tas med, plus egna
--  tillfälliga fastigheter utan lägenheter.
-- =====================================================================

create or replace function public.d2d_saljar_urval()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with t as (select my_tenant_id() as tenant, my_scope('d2d_lagenhet', 'read') as lag_scope),
  lag as (
    select rl.to_record_id as fid, count(*) as n
      from t
      join relationships rl on rl.tenant_id = t.tenant and rl.rel_type = 'd2d_lag_fastighet'
      join records l on l.id = rl.from_record_id and l.deleted_at is null
     where can_do('d2d_fastighet', 'read') and in_scope(t.lag_scope, l.owner_user_id)
     group by rl.to_record_id
  ),
  fast as (
    select f.id, f.title, f.status, f.owner_user_id, f.created_at, f.updated_at,
           f.data - 'manuell_tilldelning' - 'saljartilldelning' as data,
           coalesce(lag.n, 0) as n,
           (select rp.to_record_id from relationships rp
              join records p on p.id = rp.to_record_id and p.deleted_at is null
             where rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt' limit 1) as projekt_id
      from t
      join records f on f.tenant_id = t.tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
      left join lag on lag.fid = f.id
     where can_do('d2d_fastighet', 'read')
       and (lag.n > 0 or (f.owner_user_id = auth.uid() and f.data->>'tillfallig' = 'true'))
  )
  select jsonb_build_object(
    'fastigheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'object_type', 'd2d_fastighet', 'title', title, 'status', status,
        'owner_user_id', owner_user_id, 'created_at', created_at, 'updated_at', updated_at,
        'data', data, 'antal', n, 'projekt_id', projekt_id)) from fast), '[]'::jsonb),
    'projekt', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'object_type', 'd2d_projekt', 'title', p.title, 'status', p.status,
        'owner_user_id', p.owner_user_id, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'data', p.data))
        from records p
       where p.id in (select projekt_id from fast where projekt_id is not null)), '[]'::jsonb)
  )
$function$;

grant execute on function public.d2d_saljar_urval() to authenticated;
