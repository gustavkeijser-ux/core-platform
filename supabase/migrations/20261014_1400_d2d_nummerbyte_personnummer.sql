-- D2D: kundens personnummer följer med till nummerbytet (fält personnummer),
-- står i admin-uppgiften och på kortet i Nummerbyten. Körd 2026-10-14.

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
select od.id, od.tenant_id, 'personnummer', 'Personnummer', 'text', false, '{"section":"grunduppgifter"}'::jsonb, 25, 'all'
  from object_definitions od
 where od.key = 'nummerbyte'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'personnummer');

do $do$
declare src text; a text := $a$'kalla', new.status);$a$;
begin
  src := pg_get_functiondef('public.d2d_nummerbyte_sync'::regproc);
  if position($x$'personnummer', new.data->>'personnummer'$x$ in src) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in src) = 0 then raise exception 'texten hittades inte'; end if;
  src := replace(src, a, $a$'kalla', new.status,
      'personnummer', new.data->>'personnummer');$a$);
  execute src;
end $do$;

do $do$
declare src text; a text := $a$|| 'Kund: ' || coalesce(p->>'kund', '—') || E'\n'$a$;
begin
  src := pg_get_functiondef('public.nb_task_text'::regproc);
  if position($x$'Personnummer: '$x$ in src) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in src) = 0 then raise exception 'texten hittades inte'; end if;
  src := replace(src, a, a || $b$
    || 'Personnummer: ' || coalesce(nullif(p->>'personnummer', ''), '—') || E'\n'$b$);
  execute src;
end $do$;

update records n set data = n.data || jsonb_build_object('personnummer', l.data->>'personnummer')
  from records l
 where n.object_type = 'nummerbyte' and n.deleted_at is null
   and l.id = nullif(n.data->>'lagenhet_id', '')::uuid
   and coalesce(n.data->>'personnummer', '') = '' and coalesce(l.data->>'personnummer', '') <> '';

select public.nb_refresh(id) from records where object_type = 'nummerbyte' and deleted_at is null and status = 'oppen';
