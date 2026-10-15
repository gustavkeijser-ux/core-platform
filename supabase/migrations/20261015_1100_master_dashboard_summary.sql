-- =============================================================================
-- get_dashboard_summary snabbare (15 okt 2026).
-- Funktionen stod för ~5 000 av databasens ~6 500 sekunder körtid (5 241 anrop,
-- snitt 955 ms) — den används av Översikten, menyns räknare och listornas
-- filterpiller. Den räknade med en egen count(*) per objekt och per status
-- (~100 genomsökningar av records). Nu räknas alla antal i EN genomsökning
-- (cnt, group by objekt+status). Svaret är identiskt (kontrollerat för admin
-- och säljare); admin 722 ms → 81 ms i samma mätning.
-- get_dashboard_summary_test är kvar som testkopia (bara authenticated).
-- =============================================================================
create or replace function public.get_dashboard_summary()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  -- Optimerad 15 okt 2026: alla antal (per objekt och status) räknas i EN
  -- genomgång av records (group by) i stället för en count(*) per objekt och
  -- status (~100 separata genomsökningar). Samma svar som förut.
  with due as (
    select t.id, t.title, t.due_at, t.record_id, r.title as record_title
    from tasks t
    left join records r on r.id = t.record_id
    where t.tenant_id = my_tenant_id()
      and t.completed_at is null
      and t.due_at is not null
      and t.due_at <= now() + interval '7 days'
      and task_in_scope(t.assignee_user_id, t.department_id)
  ),
  obj_scopes as (
    select od.id, od.tenant_id, od.key, od.label_singular, od.label_plural, od.icon, od.sort_order,
           public.my_scope(od.key, 'read') as read_scope
    from object_definitions od
    where od.tenant_id = my_tenant_id() and od.is_active and can_do(od.key, 'read')
  ),
  cnt as materialized (
    select r.object_type, r.status, count(*) as n
      from records r
      join obj_scopes os on os.tenant_id = r.tenant_id and os.key = r.object_type
     where r.tenant_id = my_tenant_id()
       and r.deleted_at is null
       and public.in_scope(os.read_scope, r.owner_user_id)
     group by r.object_type, r.status
  ),
  recent as (
    select r.id, r.object_type, os.label_singular, r.title, r.status, r.updated_at
    from records r
    join obj_scopes os on os.tenant_id = r.tenant_id and os.key = r.object_type
    where r.tenant_id = my_tenant_id()
      and r.deleted_at is null
      and public.in_scope(os.read_scope, r.owner_user_id)
    order by r.updated_at desc
    limit 8
  )
  select jsonb_build_object(
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', os.key,
        'labelPlural', os.label_plural,
        'icon', os.icon,
        'total', coalesce((select sum(c.n) from cnt c where c.object_type = os.key), 0),
        'statuses', coalesce((
          select jsonb_agg(jsonb_build_object(
            'key', sd.key, 'label', sd.label, 'color', sd.color,
            'count', coalesce((select c.n from cnt c where c.object_type = os.key and c.status = sd.key), 0)
          ) order by sd.sort_order)
          from status_definitions sd where sd.object_id = os.id
        ), '[]'::jsonb),
        'pipeline', (
          select jsonb_build_object(
            'fieldLabel', fd.label,
            'code', coalesce(fd.options ->> 'code', 'SEK'),
            'openValue', coalesce((
              select sum((r.data ->> fd.key)::numeric)
              from records r
              join status_definitions sd2 on sd2.object_id = os.id and sd2.key = r.status
              where r.tenant_id = os.tenant_id and r.object_type = os.key
                and r.deleted_at is null and sd2.is_terminal = false
                and public.in_scope(os.read_scope, r.owner_user_id)
                and r.data ? fd.key
            ), 0)
          )
          from field_definitions fd
          where fd.object_id = os.id and fd.field_type = 'currency'
          order by fd.sort_order limit 1
        )
      ) order by os.sort_order)
      from obj_scopes os
    ), '[]'::jsonb),
    'tasksDueSoon', jsonb_build_object(
      'count', (select count(*) from due),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'title', title, 'dueAt', due_at,
          'recordId', record_id, 'recordTitle', record_title
        ) order by due_at)
        from (select * from due order by due_at limit 5) d
      ), '[]'::jsonb)
    ),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recordId', id, 'objectType', object_type, 'objectLabel', label_singular,
        'title', title, 'status', status, 'updatedAt', updated_at
      ))
      from recent
    ), '[]'::jsonb)
  )
$function$;
revoke execute on function public.get_dashboard_summary() from public, anon;
grant execute on function public.get_dashboard_summary() to authenticated, service_role;
