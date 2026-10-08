-- [Leverans] Leveransöversikten grupperas per Kund (koncernmoder, relationen delivery_for)
-- i stället för fritexten fastighetsagare, och tar med Kundens Leveransöversikt-post
-- (objektet leveransoversikt, relationen levov_kund).
-- Grupper: Kunder med leveranser som matchar sök/filter/status + (utan sök/filter)
-- alla Leveransöversikt-poster, även de utan leveranser (t.ex. avslutade). Med sökning
-- tas poster med i träffen om namn eller avtalsparter matchar. Leveranser utan Kund
-- hamnar i gruppen kund_id = null. Samma behörighet som listan (security invoker).
create or replace function public.leverans_agare_oversikt(
  p_search text default null,
  p_filters jsonb default '[]'::jsonb
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with res as (
    select public.list_records_filtered('delivery', p_search, coalesce(p_filters, '[]'::jsonb),
                                        'updated_at', 'desc', 100000, 0) as j
  ), lev as (
    select (e->>'id')::uuid as id,
           e->>'status' as status,
           case when (e->'data'->>'lagenheter') ~ '^\s*\d+(\.\d+)?\s*$' then (e->'data'->>'lagenheter')::numeric else 0 end as lgh,
           case when (e->'data'->>'portar') ~ '^\s*\d+(\.\d+)?\s*$' then (e->'data'->>'portar')::numeric else 0 end as portar,
           nullif(btrim(e->'data'->>'responsible_lpl'), '') as lpl,
           nullif(btrim(e->'data'->>'entreprenor'), '') as entr,
           nullif(btrim(e->'data'->>'fastighetsagare'), '') as fa
      from res, jsonb_array_elements(res.j->'items') e
  ), levk as (
    select l.*, (select rl.to_record_id from relationships rl
                  where rl.from_record_id = l.id and rl.rel_type = 'delivery_for' limit 1) as kund_id
      from lev l
  ), post as (
    select distinct on (rl.to_record_id) rl.to_record_id as kund_id, p.id as post_id, p.status as post_status, p.data as pd
      from records p join relationships rl on rl.from_record_id = p.id and rl.rel_type = 'levov_kund'
     where p.object_type = 'leveransoversikt' and p.deleted_at is null
     order by rl.to_record_id, p.updated_at desc
  ), post_utan_kund as (
    select null::uuid as kund_id, p.id as post_id, p.status as post_status, p.data as pd
      from records p
     where p.object_type = 'leveransoversikt' and p.deleted_at is null
       and not exists (select 1 from relationships rl where rl.from_record_id = p.id and rl.rel_type = 'levov_kund')
  ), utan_filter as (
    select (p_search is null or btrim(p_search) = '') and jsonb_array_length(coalesce(p_filters, '[]'::jsonb)) = 0 as ja
  ), g as (
    select kund_id, count(*)::int antal, sum(lgh)::int lgh, sum(portar)::int portar,
           coalesce(jsonb_agg(distinct lpl) filter (where lpl is not null), '[]') lpl,
           coalesce(jsonb_agg(distinct entr) filter (where entr is not null), '[]') entreprenor,
           (select coalesce(jsonb_agg(jsonb_build_object('key', s.status, 'n', s.n) order by s.n desc), '[]')
              from (select status, count(*)::int n from levk k2 where k2.kund_id is not distinct from levk.kund_id group by status) s) status,
           min(fa) fa
      from levk group by kund_id
  ), alla as (
    select g.kund_id, g.antal, g.lgh, g.portar, g.lpl, g.entreprenor, g.status, g.fa,
           p.post_id, p.post_status, p.pd
      from g left join post p on p.kund_id = g.kund_id
    union all
    select p.kund_id, 0, 0, 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, p.post_id, p.post_status, p.pd
      from post p
     where not exists (select 1 from g where g.kund_id = p.kund_id)
       and ((select ja from utan_filter)
            or (p_search is not null and (p.pd->>'name' ilike '%' || p_search || '%' or p.pd->>'avtalsparter' ilike '%' || p_search || '%')))
    union all
    select null, 0, 0, 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, p.post_id, p.post_status, p.pd
      from post_utan_kund p
     where (select ja from utan_filter)
        or (p_search is not null and (p.pd->>'name' ilike '%' || p_search || '%' or p.pd->>'avtalsparter' ilike '%' || p_search || '%'))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kund_id', a.kund_id, 'agare', a.fa, 'ce', '[]'::jsonb,  -- agare/ce: bakåtkompatibelt för äldre frontend
           'kund', coalesce(k.title, a.pd->>'name', case when a.antal > 0 then 'Ingen kund kopplad' end),
           'antal', a.antal, 'lgh', a.lgh, 'portar', a.portar,
           'lpl', a.lpl, 'entreprenor', a.entreprenor, 'status', a.status,
           'post_id', a.post_id, 'post_status', a.post_status,
           'post', coalesce(a.pd, '{}'::jsonb) - 'agare_epost' - 'agare_telefon' - 'forvaltare_epost' - 'forvaltare_telefon'
         ) order by case a.post_status when 'pagaende' then 0 when 'avslutad' then 2 else 1 end, a.antal desc, coalesce(k.title, a.pd->>'name')), '[]'::jsonb)
    from alla a left join records k on k.id = a.kund_id;
$$;

grant execute on function public.leverans_agare_oversikt(text, jsonb) to authenticated;
