-- D2D: nummerbytet visar vilken mobiltjänst som sålts och om försäljningen är
-- Såld eller Signerad med Scrive. Nya fält på nummerbyte: mobiltjanst (text),
-- kalla (select sald/scrive). Fylls av triggern d2d_nummerbyte_sync och visas i
-- admin-uppgiften (nb_task_text) och på sidan Nummerbyten. Körd 2026-10-14.

-- 1. Fält på nummerbytet.
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
select od.id, od.tenant_id, v.key, v.label, v.typ, false, v.opts::jsonb, v.sort, 'all'
  from object_definitions od
 cross join (values
   ('mobiltjanst', 'Mobiltjänst', 'text', '{"section":"grunduppgifter"}', 45),
   ('kalla', 'Försäljning', 'select',
      '{"section":"grunduppgifter","choices":[{"key":"sald","label":"Såld"},{"key":"scrive","label":"Signerad med Scrive"}]}', 46)
 ) as v(key, label, typ, opts, sort)
 where od.key = 'nummerbyte'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- 2. Text för såld mobiltjänst, t.ex. "Obegränsad Plus, Extra användare ×2".
create or replace function public.d2d_mobiltjanst_text(p_data jsonb, p_tenant uuid) returns text
language sql stable as $$
  with val as (
    select case when jsonb_typeof(p_data->'salt_mobil') = 'array' then p_data->'salt_mobil'
                when coalesce(p_data->>'salt_mobil', '') not in ('', 'nej') then jsonb_build_array(p_data->>'salt_mobil')
                else '[]'::jsonb end as v),
  ch as (
    select c->>'key' as key, c->>'label' as label, ord
      from field_definitions f
      join object_definitions o on o.id = f.object_id
      cross join lateral jsonb_array_elements(f.options->'choices') with ordinality as c(c, ord)
     where o.tenant_id = p_tenant and o.key = 'd2d_lagenhet' and f.key = 'salt_mobil')
  select nullif(string_agg(
           coalesce(ch.label, x.k) || case when x.k = 'extra_anvandare' then ' ×' || public.d2d_extra_antal(p_data) else '' end,
           ', ' order by coalesce(ch.ord, 999)), '')
    from val, jsonb_array_elements_text(val.v) as x(k)
    left join ch on ch.key = x.k
$$;

-- 3. Triggern skickar med tjänst och källa.
do $do$
declare src text; a text := $a$'lagenhet_id', new.id::text);$a$;
begin
  src := pg_get_functiondef('public.d2d_nummerbyte_sync'::regproc);
  if position($x$'mobiltjanst'$x$ in src) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in src) = 0 then raise exception 'texten hittades inte'; end if;
  src := replace(src, a, $a$'lagenhet_id', new.id::text,
      'mobiltjanst', public.d2d_mobiltjanst_text(new.data, new.tenant_id),
      'kalla', new.status);$a$);
  execute src;
end $do$;

-- 4. Uppgiftstexten får raderna Mobiltjänst och Försäljning.
do $do$
declare src text; a text := $a$|| 'Adress: ' || coalesce(p->>'adress', '—') || E'\n'$a$;
begin
  src := pg_get_functiondef('public.nb_task_text'::regproc);
  if position($x$'Mobiltjänst: '$x$ in src) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in src) = 0 then raise exception 'texten hittades inte'; end if;
  src := replace(src, a, a || $b$
    || 'Mobiltjänst: ' || coalesce(nullif(p->>'mobiltjanst', ''), '—') || E'\n'
    || 'Försäljning: ' || case p->>'kalla' when 'scrive' then 'Signerad med Scrive' when 'sald' then 'Såld' else '—' end || E'\n'$b$);
  execute src;
end $do$;

-- 5. Bakfyll befintliga nummerbyten från lägenheten och skriv om uppgifterna.
update records n set data = n.data || jsonb_build_object(
    'mobiltjanst', public.d2d_mobiltjanst_text(l.data, l.tenant_id),
    'kalla', l.status)
  from records l
 where n.object_type = 'nummerbyte' and n.deleted_at is null
   and l.id = nullif(n.data->>'lagenhet_id', '')::uuid
   and coalesce(n.data->>'kalla', '') = '';

select public.nb_refresh(id) from records where object_type = 'nummerbyte' and deleted_at is null and status = 'oppen';
