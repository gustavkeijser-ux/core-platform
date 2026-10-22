-- =============================================================================
-- D2D: säljdatumet följer säljarens tjänsteändringar (Gustav 22 okt 2026).
--
-- Sedan 14 okt låses "Såld datum" (sald_datum) när adressen första gången
-- blir Såld, så att admins rättelser inte flyttar säljet. Men när en SÄLJARE
-- går in på en redan såld adress och ändrar tjänsterna (t.ex. ett sälj som
-- importerats från fil och sedan kompletteras) ska säljet räknas till den
-- dagen — alltid.
--
--  * Trigger d2d_sald_datum_tjanster: när en lägenhet med status Såld får
--    ändrade tjänstefält (salt_*, mobil_antal, mobil_extra_antal) och den
--    som ändrar är säljaren på adressen eller inte är admin, sätts
--    sald_datum till dagens datum (svensk tid). Admin som rättar åt någon
--    annan flyttar inte datumet. Import (d2d.import = 1) rör inget.
--    Ändringen loggas som field_change på sald_datum.
--  * Historik: sålda adresser där säljaren (eller en icke-admin) ändrat
--    tjänster efter säljdatumet får datumet för den senaste ändringen.
--    Loggen finns sedan 28 sep, så äldre ändringar kan inte räknas om.
-- =============================================================================

create or replace function public.d2d_tjanster_del(d jsonb) returns jsonb
language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(d, '{}'::jsonb)) as e(k, v)
                    where k like 'salt\_%' or k in ('mobil_antal', 'mobil_extra_antal')), '{}'::jsonb)
$$;

create or replace function public.d2d_sald_datum_tjanster() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_idag text; v_old text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.object_type <> 'd2d_lagenhet' or new.status <> 'sald' then return new; end if;
  if coalesce(current_setting('d2d.import', true), '') = '1' then return new; end if;
  if v_uid is null then return new; end if;
  if public.d2d_tjanster_del(new.data) = public.d2d_tjanster_del(old.data) then return new; end if;
  -- Bara säljaren själv, eller någon som inte är admin, flyttar säljdatumet.
  if v_uid::text is distinct from new.data->>'saljare' and public.is_admin() then return new; end if;

  v_idag := to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD');
  v_old := new.data->>'sald_datum';
  if v_old is distinct from v_idag then
    new.data := new.data || jsonb_build_object('sald_datum', v_idag);
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (new.tenant_id, new.id, 'field_change',
            'Såld datum flyttat till ' || v_idag || ' (tjänster ändrade av säljaren)',
            jsonb_build_object('field', 'sald_datum', 'from', v_old, 'to', v_idag, 'orsak', 'tjanster_andrade'),
            v_uid, 'system');
  end if;
  return new;
end $$;
revoke execute on function public.d2d_sald_datum_tjanster() from public, anon;

create or replace trigger trg_d2d_sald_datum_tjanster
  before update of data on public.records
  for each row when (new.object_type = 'd2d_lagenhet' and new.status = 'sald')
  execute function public.d2d_sald_datum_tjanster();

-- Historik: säljarens senaste tjänsteändring efter säljdatumet blir nytt säljdatum.
do $$
declare r record; v_ny text;
begin
  for r in
    with adm as (select ur.user_id from user_roles ur join roles rr on rr.id = ur.role_id where rr.key = 'admin')
    select l.id, l.tenant_id, l.data->>'sald_datum' as sald,
           (select max(a.occurred_at at time zone 'Europe/Stockholm')::date from activities a
             where a.record_id = l.id and a.activity_type = 'field_change'
               and (a.metadata->>'field' like 'salt\_%' or a.metadata->>'field' in ('mobil_antal', 'mobil_extra_antal'))
               and a.actor_user_id is not null
               and (a.actor_user_id not in (select user_id from adm) or a.actor_user_id::text = l.data->>'saljare')) as sista
      from records l
     where l.object_type = 'd2d_lagenhet' and l.deleted_at is null and l.status = 'sald'
       and coalesce(l.data->>'sald_datum', '') <> ''
  loop
    if r.sista is not null and r.sista > r.sald::date then
      v_ny := to_char(r.sista, 'YYYY-MM-DD');
      update records set data = data || jsonb_build_object('sald_datum', v_ny) where id = r.id;
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (r.tenant_id, r.id, 'field_change',
              'Såld datum flyttat från ' || r.sald || ' till ' || v_ny || ' (säljaren ändrade tjänster efter säljdatumet; omräkning 22 okt 2026)',
              jsonb_build_object('field', 'sald_datum', 'from', r.sald, 'to', v_ny, 'orsak', 'tjanster_andrade_omrakning'),
              null, 'system');
    end if;
  end loop;
end $$;
