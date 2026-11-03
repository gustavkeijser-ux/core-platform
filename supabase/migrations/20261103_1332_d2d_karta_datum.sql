-- D2D: Karta — tåla ogiltiga datum i leveranserna (t.ex. "2027-04-31" i avtalstid_ko).
-- d2d_datum() ger null i stället för fel, och d2d_karta() använder den för kundklar,
-- avtalstid_ko och ktv_avtal. Ändras på plats (pg_get_functiondef + replace).

create or replace function public.d2d_datum(p text)
 returns date language plpgsql immutable set search_path to 'public'
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(p, 10)::date;
exception when others then
  return null;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.d2d_karta()'::regprocedure);
  v_ny text := v_def;
  k text;
begin
  foreach k in array array['kundklar', 'avtalstid_ko', 'ktv_avtal'] loop
    v_ny := replace(v_ny,
      format('case when l.d->>%L ~ ''^\d{4}-\d{2}-\d{2}'' then left(l.d->>%L, 10)::date end', k, k),
      format('d2d_datum(l.d->>%L)', k));
  end loop;
  if v_ny = v_def then
    if v_def like '%d2d_datum(l.d->>''kundklar'')%' then return; end if;  -- redan gjort
    raise exception 'd2d_karta: hittade inte datumuttrycken som ska bytas';
  end if;
  if v_ny like '%::date end%' then raise exception 'd2d_karta: alla datumuttryck byttes inte'; end if;
  execute v_ny;
end $$;
