-- D2D: nummerbytesärende skapas även vid "Signera med Scrive" (status scrive),
-- inte bara vid Såld. Signeringsdatum tas från scrive_signerad när det finns.
-- Ändrar d2d_nummerbyte_sync på plats (0029). Körd i databasen 2026-10-14.
do $do$
declare src text; a text := $a$v_want := new.status = 'sald'$a$; b text := $b$(new.status <> 'sald' or$b$; c text := $c$coalesce(nullif(new.data->>'sald_datum', ''), current_date::text)$c$;
begin
  src := pg_get_functiondef('public.d2d_nummerbyte_sync'::regproc);
  if position($x$new.status in ('sald','scrive')$x$ in src) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in src) = 0 or position(b in src) = 0 or position(c in src) = 0 then raise exception 'texten hittades inte'; end if;
  src := replace(src, a, $a$v_want := new.status in ('sald','scrive')$a$);
  src := replace(src, b, $b$(new.status not in ('sald','scrive') or$b$);
  src := replace(src, c, $c$coalesce(nullif(new.data->>'scrive_signerad', ''), nullif(new.data->>'sald_datum', ''), current_date::text)$c$);
  execute src;
end $do$;

-- Skapa ärenden för Scrive-lägenheter som redan har tillfälligt nummer ifyllt.
update records set updated_at = updated_at
 where object_type = 'd2d_lagenhet' and deleted_at is null and status = 'scrive'
   and data->>'mobil_nummerval' = 'tillfalligt' and coalesce(data->>'mobil_nummerbyte_id', '') = '';
