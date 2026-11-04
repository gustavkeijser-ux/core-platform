-- D2D: Biet 3 (Halmstad, D2D-fastigheten "Backhausgatan 5") läggs sist i projektet Skåne.
-- Fastigheten har 46 lägenheter men saknade projekt. Idempotent; inget görs om posterna saknas.
do $$
declare
  v_fast uuid := 'cfd59738-338c-4e56-b362-f62a695a966e';  -- d2d_fastighet Backhausgatan 5 (Biet 3, Halmstad)
  v_proj uuid := '2542c856-ac33-4997-900a-f96c565e2cbf';  -- d2d_projekt Skåne
  v_tenant uuid; v_tur int;
begin
  select tenant_id into v_tenant from records
   where id = v_fast and object_type = 'd2d_fastighet' and deleted_at is null;
  if v_tenant is null then raise notice 'Biet 3 finns inte, hoppar över'; return; end if;
  if not exists (select 1 from records where id = v_proj and object_type = 'd2d_projekt' and deleted_at is null) then
    raise notice 'Projektet Skåne finns inte, hoppar över'; return;
  end if;
  if exists (select 1 from relationships where from_record_id = v_fast and to_record_id = v_proj and rel_type = 'd2d_fast_projekt') then
    return;
  end if;

  select coalesce(max(nullif(regexp_replace(coalesce(f.data->>'turordning', ''), '\D', '', 'g'), '')::int), 0) + 1 into v_tur
    from relationships p join records f on f.id = p.from_record_id and f.deleted_at is null
   where p.to_record_id = v_proj and p.rel_type = 'd2d_fast_projekt';

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  values (v_tenant, v_fast, v_proj, 'd2d_fast_projekt') on conflict do nothing;
  update records set data = data || jsonb_build_object('turordning', v_tur), updated_at = now()
   where id = v_fast;
end $$;
