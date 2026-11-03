-- [Leverans] CE-leveransansvarig per fastighet (Gustav 3 nov): hämtas från
-- "ConnectEstate leverans & översikt – Lista signering" (kolumnen CE-ansvarig, som
-- ligger på koncernmoderns Leveransöversikt-post) och går att ändra i
-- Leveransöversikten → Alla fastigheter. Idempotent.
--
-- * Fältet ce_ansvarig (användare, tomt på alla leveranser) får etiketten
--   CE-leveransansvarig; nytt fält ce_ansvarig_2 (CE-leveransansvarig 2) för
--   koncernmödrar där listan anger två personer ("Gustav/Jonas" → båda).
-- * Fältet Leveransansvarig (felanmälningar) rörs inte (Gustavs val).
-- * Förifyllning bara där fastighetens CE-leveransansvarig är tom. Namnen i
--   listan matchas mot användarnas namn (förnamn räcker).

update field_definitions fd set label = 'CE-leveransansvarig'
  from object_definitions od
 where od.id = fd.object_id and od.key = 'delivery' and fd.key = 'ce_ansvarig'
   and fd.label is distinct from 'CE-leveransansvarig';

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, 'ce_ansvarig_2', 'CE-leveransansvarig 2', 'user', false,
       '{"section":"resurser","_column":false}'::jsonb, 806
  from object_definitions od
 where od.key = 'delivery'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'ce_ansvarig_2');

with post as (
  select distinct on (rl.to_record_id) rl.to_record_id as kund_id, p.tenant_id, p.data->>'ce_ansvarig' as ce
    from records p join relationships rl on rl.from_record_id = p.id and rl.rel_type = 'levov_kund'
   where p.object_type = 'leveransoversikt' and p.deleted_at is null
     and nullif(btrim(p.data->>'ce_ansvarig'), '') is not null
   order by rl.to_record_id, p.updated_at desc
), namn as (
  select po.kund_id, n.ord, btrim(n.namn) as namn, po.tenant_id
    from post po, regexp_split_to_table(po.ce, '\s*[/|,&]\s*|\s+och\s+') with ordinality as n(namn, ord)
   where btrim(n.namn) <> ''
), anv as (
  select nm.kund_id, nm.ord,
         (select u.id from users u
           where u.tenant_id = nm.tenant_id and u.deleted_at is null and u.is_active
             and (lower(btrim(u.full_name)) = lower(nm.namn)
                  or lower(split_part(btrim(u.full_name), ' ', 1)) = lower(nm.namn))
           order by (lower(btrim(u.full_name)) = lower(nm.namn)) desc, u.created_at
           limit 1) as uid
    from namn nm
), per_kund as (
  select kund_id, array_agg(uid order by ord) filter (where uid is not null) as uids
    from anv group by kund_id
), lev as (
  select distinct on (d.id) d.id, pk.uids
    from records d
    join relationships rk on rk.from_record_id = d.id and rk.rel_type = 'delivery_for'
    join per_kund pk on pk.kund_id = rk.to_record_id
   where d.object_type = 'delivery' and d.deleted_at is null
     and nullif(d.data->>'ce_ansvarig', '') is null
     and cardinality(pk.uids) > 0
   order by d.id, rk.created_at
)
update records r
   set data = r.data
              || jsonb_build_object('ce_ansvarig', lev.uids[1]::text)
              || case when cardinality(lev.uids) > 1 and lev.uids[2] <> lev.uids[1]
                      then jsonb_build_object('ce_ansvarig_2', lev.uids[2]::text) else '{}'::jsonb end
  from lev where r.id = lev.id;

create or replace function public.leverans_fastighetslista(
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
    select (e->>'id')::uuid as id, e->>'status' as status, e->'data' as d
      from res, jsonb_array_elements(res.j->'items') e
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'status', l.status,
           'kund_id', k.id,
           'kund', coalesce(k.namn, nullif(btrim(l.d->>'fastighetsagare'), '')),
           'kund_kopplad', k.id is not null,
           'bolag', coalesce(b.namn, nullif(btrim(l.d->>'bolagsnamn'), '')),
           'ort', l.d->>'ort',
           'fastighet', l.d->>'fastighetsbeteckning',
           'adress', l.d->>'adress',
           'hushall', l.d->'lagenheter',
           'fs_portar', l.d->'fs_portar',
           'sc_portar', l.d->'sc_portar',
           'fbl', l.d->>'fbl',
           'kundklar', l.d->>'kundklar',
           'kundklar_ce', l.d->>'kundklar_ce',
           'telia_status', l.d->>'projektplan_status',
           'leverans', coalesce(nullif(l.d->>'kanalpaket', ''), nullif(l.d->>'kollektivt_internet', '')),
           'bef_ko', nullif(l.d->>'befintlig_fiberleverantor', ''),
           'avtalstid_ko', l.d->>'avtalstid_ko',
           'bef_koax', coalesce(nullif(l.d->>'befintlig_koax', ''), x.koax),
           'ktv_avtal', l.d->>'ktv_avtal',
           'lpl', l.d->>'responsible_lpl',
           'entreprenor', l.d->>'entreprenor',
           'projektledare', l.d->>'projektledare',
           'telianow_cs', l.d->>'telianow_cs',
           'ce_ansvariga', (select coalesce(jsonb_agg(v), '[]'::jsonb)
                              from unnest(array[nullif(l.d->>'ce_ansvarig', ''), nullif(l.d->>'ce_ansvarig_2', '')]) v
                             where v is not null),
           'detalj', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                        from jsonb_each(l.d) e
                       where e.key like 'chk\_%'
                          or e.key in ('kontakt_agare_namn', 'kontakt_agare_epost',
                                       'forvaltare_namn', 'forvaltare_epost', 'forvaltare_telefon'))
         ) order by lower(coalesce(k.namn, l.d->>'fastighetsagare', 'ö')), lower(l.d->>'ort'), lower(l.d->>'fastighetsbeteckning')), '[]'::jsonb)
    from lev l
    left join lateral (
      select r.id, coalesce(nullif(r.title, ''), r.data->>'name') as namn
        from relationships rl join records r on r.id = rl.to_record_id and r.deleted_at is null
       where rl.from_record_id = l.id and rl.rel_type = 'delivery_for'
       limit 1) k on true
    left join lateral (
      select coalesce(nullif(r.title, ''), r.data->>'name') as namn
        from relationships rl join records r on r.id = rl.to_record_id and r.deleted_at is null
       where rl.from_record_id = l.id and rl.rel_type = 'delivery_for_db'
       limit 1) b on true
    left join lateral (
      select string_agg(distinct f.data->>'befintlig_koax', ', ') as koax
        from relationships rl join records f on f.id = rl.from_record_id and f.deleted_at is null
       where rl.to_record_id = l.id and rl.rel_type = 'd2d_fast_delivery'
         and nullif(btrim(f.data->>'befintlig_koax'), '') is not null) x on true
$$;

revoke all on function public.leverans_fastighetslista(text, jsonb) from public, anon;
grant execute on function public.leverans_fastighetslista(text, jsonb) to authenticated;
