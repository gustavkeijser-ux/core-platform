-- =============================================================================
-- D2D: telefonnummer i kommentaren fyller fältet Telefon (Gustav 16 okt,
-- "gäller ALLA lägenheter").
--
--  * d2d_telefon_ur_text(text): första numret i en fritext, mobil (07x,
--    +46 7x) i första hand, annars fast nummer (0x…). Bara siffror med
--    inledande 0: "076-843 32 64" → "0768433264" (samma form som fältet).
--    Ofullständiga nummer (t.ex. 9 siffror på mobil) räknas inte.
--  * Trigger trg_d2d_telefon_fran_kommentar: när en kommentar skrivs eller
--    ändras och Telefon är tomt fylls det i. Ett ifyllt telefonfält skrivs
--    aldrig över, och ett fält som någon tömt fylls inte i igen förrän
--    kommentaren ändras. Kommentaren rörs inte.
--  * Engångskörning 16 okt: 1 628 lägenheter fick telefon från kommentaren
--    (aktivitet field_change, metadata.kalla = 'telefon_ur_kommentar').
--    133 lägenheter har redan ett annat nummer i Telefon än i kommentaren —
--    de lämnades orörda.
-- =============================================================================

create or replace function public.d2d_telefon_ur_text(p text) returns text
language plpgsql immutable set search_path = public as $$
declare m text;
begin
  if p is null or p = '' then return null; end if;
  m := substring(p from '(?:^|[^\d+])((?:\+46|0046|0)[\s-]*7[\s-]*\d(?:[\s-]*\d){7})(?!\d)');
  if m is null then
    m := substring(p from '(?:^|[^\d+])((?:\+46|0046)[\s-]*[1-68-9](?:[\s-]*\d){6,8}|0[1-68-9](?:[\s-]*\d){6,8})(?![\s-]*\d)');
  end if;
  if m is null then return null; end if;
  m := regexp_replace(m, '\D', '', 'g');
  if m like '0046%' then m := '0' || substr(m, 5);
  elsif m like '46%' then m := '0' || substr(m, 3); end if;
  return m;
end $$;
revoke execute on function public.d2d_telefon_ur_text(text) from public, anon;
grant execute on function public.d2d_telefon_ur_text(text) to authenticated, service_role;

create or replace function public.d2d_telefon_fran_kommentar() returns trigger
language plpgsql set search_path = public as $$
declare v text;
begin
  if new.object_type = 'd2d_lagenhet'
     and coalesce(new.data->>'kund_telefon', '') = ''
     and coalesce(new.data->>'kommentar', '') <> ''
     and (tg_op = 'INSERT' or (old.data->>'kommentar') is distinct from (new.data->>'kommentar')) then
    v := d2d_telefon_ur_text(new.data->>'kommentar');
    if v is not null then
      new.data := new.data || jsonb_build_object('kund_telefon', v);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.d2d_telefon_fran_kommentar() from public, anon;

create or replace trigger trg_d2d_telefon_fran_kommentar
  before insert or update of data on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_telefon_fran_kommentar();

-- Engångskörning (i omgångar om 400).
do $$
declare n int;
begin
  loop
    with valda as (
      select id, d2d_telefon_ur_text(data->>'kommentar') tel from records
       where object_type = 'd2d_lagenhet' and deleted_at is null and coalesce(data->>'kund_telefon', '') = ''
         and d2d_telefon_ur_text(data->>'kommentar') is not null
       limit 400),
    upd as (
      update records r set data = r.data || jsonb_build_object('kund_telefon', v.tel)
        from valda v where r.id = v.id returning r.id, r.tenant_id, v.tel),
    ins as (
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind, occurred_at)
      select tenant_id, id, 'field_change', 'Telefon hämtat från kommentaren',
             jsonb_build_object('field', 'kund_telefon', 'from', null, 'to', tel, 'kalla', 'telefon_ur_kommentar'), 'system', now()
        from upd returning 1)
    select count(*) into n from ins;
    exit when n = 0;
  end loop;
end $$;
