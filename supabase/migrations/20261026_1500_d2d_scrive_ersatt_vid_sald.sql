-- Scrive → Såld (Gustav 26 okt): när en adress med signerat Scrive-avtal blir Såld
-- (säljaren byter status och lämnar kortet, eller Telias VT-underlag visar orderlagd)
-- tas Scrive-avtalet bort ur räkningen och affären räknas som Såld.
-- Avtalet raderas inte: det får status 'ersatt' så att den signerade PDF:en finns kvar.
-- Går adressen tillbaka till Scrive blir avtalet signerat igen.

-- 1. Ny avtalsstatus
alter table public.d2d_avtal drop constraint if exists d2d_avtal_status_check;
alter table public.d2d_avtal add constraint d2d_avtal_status_check
  check (status in ('skapas', 'vantar', 'signerat', 'avvisat', 'avbrutet', 'fel', 'ersatt'));

-- 2. Statuskoll mot Scrive (poll/callback) får inte göra ett ersatt avtal signerat igen
create or replace function public.d2d_avtal_ersatt_skydd()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'ersatt' and new.status is distinct from 'ersatt'
     and coalesce(current_setting('d2d.avtal_ersatt', true), '') <> '1' then
    new.status := 'ersatt';
  end if;
  return new;
end $$;
create or replace trigger trg_d2d_avtal_ersatt_skydd before update on public.d2d_avtal
  for each row execute function public.d2d_avtal_ersatt_skydd();

-- Ej mer-analysen ska inte köras om när ett ersatt avtal återställs
create or replace function public.trg_d2d_avtal_ej_mer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'signerat' and old.status is distinct from 'signerat' and old.status is distinct from 'ersatt' then
    perform d2d_ej_mer_kor(array[new.lagenhet_id]);
  end if;
  return new;
end $$;

-- 3. Lägenheten: räknad status (avtalsunderlaget) Scrive/annat → Såld ersätter signerat avtal, och tvärtom
create or replace function public.d2d_scrive_ersatt_trg()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fore text := d2d_ust(old.status, old.data); v_nu text := d2d_ust(new.status, new.data); v_n int;
begin
  if v_nu = 'sald' and v_fore is distinct from 'sald' then
    perform set_config('d2d.avtal_ersatt', '1', true);
    update d2d_avtal set status = 'ersatt' where lagenhet_id = new.id and status = 'signerat';
    get diagnostics v_n = row_count;
    perform set_config('d2d.avtal_ersatt', '', true);
    if v_n > 0 then
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (new.tenant_id, new.id, 'field_change', 'Scrive-avtalet ersatt – affären är Såld',
              jsonb_build_object('scrive_ersatt', v_n), auth.uid(), 'system');
    end if;
  elsif v_fore = 'sald' and v_nu = 'scrive' then
    perform set_config('d2d.avtal_ersatt', '1', true);
    update d2d_avtal set status = 'signerat' where lagenhet_id = new.id and status = 'ersatt';
    get diagnostics v_n = row_count;
    perform set_config('d2d.avtal_ersatt', '', true);
    if v_n > 0 then
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (new.tenant_id, new.id, 'field_change', 'Scrive-avtalet gäller igen – adressen är tillbaka på Scrive',
              jsonb_build_object('scrive_aterstallt', v_n), auth.uid(), 'system');
    end if;
  end if;
  return null;
end $$;
create or replace trigger trg_d2d_scrive_ersatt after update on public.records
  for each row when (new.object_type = 'd2d_lagenhet') execute function public.d2d_scrive_ersatt_trg();

-- 4. Telia VT-underlag: orderlagd (Open/Complete) på en Scrive-adress → Såld.
--    Säljdatum = dagen kunden signerade (admin-importen flyttar inte säljdatum till idag).
--    Ny åtgärd 'scrive_till_sald' syns i förhandsvisningen.
do $do$
declare d text := pg_get_functiondef('public.d2d_telia_vt_import(jsonb, boolean)'::regprocedure);
  a1 text := $a$      when v_st in ('open', 'complete', 'completed') then 'orderlagd'$a$;
  b1 text := $b$      when v_st in ('open', 'complete', 'completed') and v_lag.status = 'scrive' then 'scrive_till_sald'
      when v_st in ('open', 'complete', 'completed') then 'orderlagd'$b$;
  a2 text := $a$      elsif v_atg = 'orderlagd' then$a$;
  b2 text := $b$      elsif v_atg in ('orderlagd', 'scrive_till_sald') then
        if v_atg = 'scrive_till_sald' then
          update records set status = 'sald',
                 data = data || jsonb_build_object('sald_datum', coalesce(
                   (select to_char(coalesce(da.signerad, da.uppdaterad) at time zone 'Europe/Stockholm', 'YYYY-MM-DD')
                      from d2d_avtal da where da.lagenhet_id = v_lag.id and da.status = 'signerat'
                     order by coalesce(da.signerad, da.uppdaterad) desc limit 1),
                   nullif(data->>'sald_datum', ''),
                   to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')))
           where id = v_lag.id;
          perform log_activity(v_lag.id, 'status_change', 'Status satt till Såld enligt Telia-underlag' || coalesce(' (order ' || nullif(x->>'order', '') || ')', ''),
                               jsonb_build_object('from', 'scrive', 'to', 'sald', 'kalla', 'telia_vt'));
        end if;$b$;
begin
  if position('scrive_till_sald' in d) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'hittar inte texten'; end if;
  execute replace(replace(d, a1, b1), a2, b2);
end $do$;

-- 5. Befintliga: signerade avtal på adresser som redan räknas som Såld
update d2d_avtal da set status = 'ersatt' from records l
 where l.id = da.lagenhet_id and da.status = 'signerat' and d2d_ust(l.status, l.data) = 'sald';
