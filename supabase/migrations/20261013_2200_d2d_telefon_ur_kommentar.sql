-- 20261013_2200 — Telefonnummer ur kommentaren till fältet Telefon på återkopplingar.
-- d2d_telefon_ur_text: första telefonnumret i en fritext. Mobil (07…) föredras framför
-- fast nummer; +46/0046 blir 0; personnummer och datum (siffror direkt intill) hoppas över.
-- Engångskörning 13 okt: 694 återkopplingar utan telefon fick numret ur kommentaren
-- (710 av 1 137 har nu telefon; resten saknar nummer i kommentaren).
create or replace function public.d2d_telefon_ur_text(p text)
returns text language plpgsql immutable as $f$
declare m text; d text; fast text;
begin
  for m in select (regexp_matches(coalesce(p,''), '(?<![\d/:.-])((?:\+46|0046|0)[\s-]?\d(?:[\s-]?\d){6,10})(?![\d/:.])', 'g'))[1] loop
    d := regexp_replace(m, '\D', '', 'g');
    if d like '0046%' then d := '0' || substr(d, 5);
    elsif m like '+46%' then d := '0' || substr(d, 3); end if;
    if d ~ '^07\d{8}$' then return d; end if;
    if fast is null and d ~ '^0[1-68-9]\d{6,8}$' then fast := d; end if;
  end loop;
  return fast;
end $f$;

update records r set data = r.data || jsonb_build_object('kund_telefon', d2d_telefon_ur_text(r.data->>'kommentar')), updated_at = now()
 where r.object_type = 'd2d_lagenhet' and r.deleted_at is null and r.status = 'aterkoppling'
   and nullif(btrim(r.data->>'kund_telefon'), '') is null
   and d2d_telefon_ur_text(r.data->>'kommentar') is not null;
