-- [Leverans] Kortvyn grupperad per fastighetsägare.
-- Återanvänder list_records_filtered (behörighet, sök, filter, status precis som listan)
-- och summerar per data->>'fastighetsagare': antal fastigheter, antal per status,
-- summa lägenheter, och de olika värdena för Telia LPL, CE-ansvarig och entreprenör.
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
  ), r as (
    select nullif(btrim(e->'data'->>'fastighetsagare'), '') as agare,
           e->>'status' as status,
           case when (e->'data'->>'lagenheter') ~ '^\s*\d+(\.\d+)?\s*$'
                then (e->'data'->>'lagenheter')::numeric else 0 end as lgh,
           nullif(btrim(e->'data'->>'responsible_lpl'), '') as lpl,
           nullif(btrim(e->'data'->>'ce_ansvarig'), '') as ce,
           nullif(btrim(e->'data'->>'entreprenor'), '') as entr
      from res, jsonb_array_elements(res.j->'items') e
  ), g as (
    select agare,
           count(*)::int as antal,
           sum(lgh)::int as lgh,
           (select coalesce(jsonb_agg(jsonb_build_object('key', s.status, 'n', s.n) order by s.n desc), '[]')
              from (select status, count(*)::int n from r r2 where r2.agare is not distinct from r.agare group by status) s) as status,
           coalesce(jsonb_agg(distinct lpl) filter (where lpl is not null), '[]') as lpl,
           coalesce(jsonb_agg(distinct ce) filter (where ce is not null), '[]') as ce,
           coalesce(jsonb_agg(distinct entr) filter (where entr is not null), '[]') as entreprenor
      from r
     group by agare
  )
  select coalesce(jsonb_agg(to_jsonb(g) order by g.antal desc, g.agare nulls last), '[]'::jsonb) from g;
$$;

grant execute on function public.leverans_agare_oversikt(text, jsonb) to authenticated;
