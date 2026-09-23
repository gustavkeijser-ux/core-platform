-- Gustav: "man måste kunna radera hela projekt också." Tidigare kunde man
-- bara plocka bort enskilda fastigheter ur ett projekt (removeFastighet i
-- ProjectDetail, som bara tar bort relationen d2d_fast_projekt — inte en
-- riktig radering). d2d_delete_projekt() gör en kaskaderande mjuk radering
-- (deleted_at) av projektet och allt som hänger på det: varje d2d_fastighet
-- länkad via d2d_fast_projekt, och för var och en av dem varje d2d_lagenhet
-- länkad via d2d_lag_fastighet. Varje raderad post skrivs till audit_log via
-- write_audit(), och ett events-event ('record.deleted') skickas för
-- projektet med antal borttagna fastigheter/lägenheter i payloaden.
create or replace function public.d2d_delete_projekt(p_projekt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_projekt    records%rowtype;
  v_fast       record;
  v_lag        record;
  v_fast_count integer := 0;
  v_lag_count  integer := 0;
begin
  select * into v_projekt from records
   where id = p_projekt_id and tenant_id = my_tenant_id()
     and object_type = 'd2d_projekt' and deleted_at is null;

  if not found then
    raise exception 'Inget D2D-projekt med id %', p_projekt_id using errcode = 'P0002';
  end if;

  if not can_row('d2d_projekt', 'delete', v_projekt.owner_user_id) then
    raise exception 'Saknar behörighet att ta bort projektet' using errcode = '42501';
  end if;

  for v_fast in
    select rf.id, rf.data
    from public.relationships r
    join public.records rf on rf.id = r.from_record_id
    where r.to_record_id = p_projekt_id
      and r.rel_type = 'd2d_fast_projekt'
      and r.tenant_id = my_tenant_id()
      and rf.deleted_at is null
  loop
    for v_lag in
      select rl.id, rl.data
      from public.relationships r2
      join public.records rl on rl.id = r2.from_record_id
      where r2.to_record_id = v_fast.id
        and r2.rel_type = 'd2d_lag_fastighet'
        and r2.tenant_id = my_tenant_id()
        and rl.deleted_at is null
    loop
      update public.records set deleted_at = now() where id = v_lag.id;
      perform write_audit('delete', 'd2d_lagenhet', v_lag.id, v_lag.data, null);
      v_lag_count := v_lag_count + 1;
    end loop;

    update public.records set deleted_at = now() where id = v_fast.id;
    perform write_audit('delete', 'd2d_fastighet', v_fast.id, v_fast.data, null);
    v_fast_count := v_fast_count + 1;
  end loop;

  update public.records set deleted_at = now() where id = p_projekt_id;
  perform write_audit('delete', 'd2d_projekt', p_projekt_id, v_projekt.data, null);
  perform emit_event('record.deleted', p_projekt_id,
    jsonb_build_object('objectType', 'd2d_projekt', 'fastigheter', v_fast_count, 'lagenheter', v_lag_count));

  return jsonb_build_object('fastigheter', v_fast_count, 'lagenheter', v_lag_count);
end;
$$;

grant execute on function public.d2d_delete_projekt(uuid) to authenticated;
