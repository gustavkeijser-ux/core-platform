-- Utfall → Excel-rapport (Gustav 19 okt). Underlaget för rapporten; Excel-filen byggs i webbläsaren
-- (src/lib/xlsxSkriv.ts) och matchas där mot en uppladdad VT-export.
--
-- d2d_utfall_rapport(p_fran, p_till, p_projekt, p_saljare) → jsonb
--   lagenheter: alla lägenheter som är sålda i perioden (såld-tidpunkt = d2d_sald_tid, samma som
--               lönen) och/eller har ett Scrive-avtal skapat eller signerat i perioden.
--               Per lägenhet: adress, projekt, säljare, kundtjänst, status, tider, tjänster
--               (nycklar + etiketter), kategorier (för attach rate), antal avtal och pinnar.
--   avtal:      alla Scrive-avtal skapade i perioden (skickade), med status och tider.
-- Samma behörighet som Utfall. Inga personnummer; kundnamn ingår inte.
create or replace function public.d2d_utfall_rapport(
  p_fran date default null, p_till date default null, p_projekt uuid default null, p_saljare uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb; v_scope text; v_t uuid := my_tenant_id(); v_mod jsonb;
        v_fran timestamptz; v_till timestamptz;
begin
  if not (is_admin() or my_scope('d2d_lagenhet', 'read') = 'tenant') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v_scope := my_scope('d2d_lagenhet', 'read');
  v_mod := d2d_lonemodell_for(v_t);
  v_fran := coalesce(p_fran, '2000-01-01'::date)::timestamp at time zone 'Europe/Stockholm';
  v_till := (coalesce(p_till, '2999-12-31'::date) + 1)::timestamp at time zone 'Europe/Stockholm';

  with av as (
    select da.id, da.lagenhet_id, da.status, da.skapad, coalesce(da.signerad, case when da.status = 'signerat' then da.uppdaterad end) signerad,
           da.skapad_av
      from d2d_avtal da
     where da.tenant_id = v_t
  ),
  l0 as (
    select distinct on (l.id) l.id, l.status, l.data d, l.owner_user_id,
           nullif(l.data->>'saljare', '') saljare, rp.to_record_id projekt_id,
           case when l.status in ('sald', 'anger') then d2d_sald_tid(l.id, l.data) end sald_tid
      from records l
      left join relationships rf on rf.from_record_id = l.id and rf.rel_type = 'd2d_lag_fastighet'
      left join relationships rp on rp.from_record_id = rf.to_record_id and rp.rel_type = 'd2d_fast_projekt'
     where l.tenant_id = v_t and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and coalesce(l.data->>'tillfallig', '') <> 'true'
       and in_scope(v_scope, l.owner_user_id)
       and (l.status in ('sald', 'anger') or exists (select 1 from av where av.lagenhet_id = l.id))
  ),
  l as (
    select l0.*,
           (l0.status = 'sald' and l0.sald_tid >= v_fran and l0.sald_tid < v_till) sald_i_period,
           (select max(av.signerad) from av where av.lagenhet_id = l0.id and av.status = 'signerat') signerad,
           (select max(av.skapad) from av where av.lagenhet_id = l0.id) skickad,
           (select av.status from av where av.lagenhet_id = l0.id order by av.skapad desc limit 1) avtal_status
      from l0
     where (p_projekt is null or l0.projekt_id = p_projekt)
       and (p_saljare is null or l0.saljare = p_saljare::text or l0.d->>'kundtjanst' = p_saljare::text)
  ),
  urval as (
    select l.*, (l.signerad >= v_fran and l.signerad < v_till) signerad_i_period
      from l
     where (l.status = 'sald' and l.sald_tid >= v_fran and l.sald_tid < v_till)
        or exists (select 1 from av where av.lagenhet_id = l.id
                    and ((av.skapad >= v_fran and av.skapad < v_till) or (av.signerad >= v_fran and av.signerad < v_till)))
  )
  select jsonb_build_object(
    'fran', p_fran, 'till', p_till,
    'lagenheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'gata', u.d->>'gatunamn', 'nummer', u.d->>'gatunummer', 'ingang', u.d->>'ingang', 'lgh', u.d->>'name',
        'postnummer', u.d->>'postnummer', 'ort', u.d->>'postort',
        'projekt', (select p.title from records p where p.id = u.projekt_id),
        'saljareId', u.saljare,
        'saljare', (select coalesce(nullif(x.full_name, ''), x.email::text) from users x where x.id::text = u.saljare),
        'kundtjanst', (select coalesce(nullif(x.full_name, ''), x.email::text) from users x
                        where x.id::text = u.d->>'kundtjanst' and u.d->>'kundtjanst' is distinct from u.saljare),
        'status', u.status,
        'saldTid', u.sald_tid, 'saldIPeriod', u.sald_i_period,
        'skickad', u.skickad, 'signerad', u.signerad, 'signeradIPeriod', coalesce(u.signerad_i_period, false),
        'avtalStatus', u.avtal_status,
        'tjanster', coalesce((select jsonb_agg(jsonb_build_object('nyckel', t, 'etikett', d2d_tjanst_etikett(v_t, t)) order by t)
                                from d2d_tjanst_rader(u.d) t), '[]'::jsonb),
        'kategorier', coalesce((select jsonb_agg(k) from d2d_kategori_rader(u.d) k), '[]'::jsonb),
        'avtal', d2d_antal_avtal(u.d),
        'pinnar', d2d_pinnar(u.d, v_mod),
        'vtBestallning', (select vb.status from records vb where vb.id::text = u.d->>'vt_bestallning_id' and vb.deleted_at is null))
        order by coalesce(u.sald_tid, u.signerad, u.skickad), u.d->>'gatunamn', u.d->>'gatunummer', u.d->>'name')
      from urval u), '[]'::jsonb),
    'avtal', coalesce((select jsonb_agg(jsonb_build_object(
        'id', av.id, 'lagenhetId', av.lagenhet_id, 'status', av.status, 'skickad', av.skapad, 'signerad', av.signerad,
        'skickadAv', (select coalesce(nullif(x.full_name, ''), x.email::text) from users x where x.id = av.skapad_av))
        order by av.skapad)
      from av join l on l.id = av.lagenhet_id
     where av.skapad >= v_fran and av.skapad < v_till), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.d2d_utfall_rapport(date, date, uuid, uuid) from public, anon;
grant execute on function public.d2d_utfall_rapport(date, date, uuid, uuid) to authenticated;
