-- =====================================================================
--  Utfall: snitt antal avtal per kund — totalt och per säljare.
--  perSaljare får 'avtal' (summa d2d_antal_avtal över sålda/signerade
--  kunder) och sald får 'avtalSumma'. Snittet (avtal / salda) räknas i
--  frontend. Ändrar d2d_utfall_kalla på plats.
--
--  Obs: migration 0069 (d2d_antal_avtal + sald.antalAvtal) visade sig
--  aldrig ha körts i databasen, därför visade "Antal avtal per kund"
--  bara nollor. Den tas med här igen (idempotent) så att allt hänger ihop.
-- =====================================================================

-- 1. Från 0069: antal avtal (tjänster) per kund.
create or replace function public.d2d_antal_avtal(d jsonb)
returns int language sql immutable as $$
  select greatest(1,
      (case when nullif(d->>'salt_bredband', '') is not null or d->'salt_svar'->>'salt_bredband' = 'true'
              or not (d ? 'salt_svar' or d ? 'salt_bredband' or d ? 'salt_mobil' or d ? 'salt_tv') then 1 else 0 end)
    + (case when d2d_tv_raknas(d) then 1 else 0 end)
    + greatest(
        (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array' then d->'mobil_nummer'->'rows' else '[]'::jsonb end) x
          where x->>'typ' = 'huvud'),
        (select count(*) from jsonb_array_elements_text(d2d_arr(d->'salt_mobil')) x where x <> 'extra_anvandare'))::int
    + greatest(
        (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array' then d->'mobil_nummer'->'rows' else '[]'::jsonb end) x
          where x->>'typ' = 'extra'),
        case when d2d_arr(d->'salt_mobil') ? 'extra_anvandare' then 1 else 0 end)::int
    + (case when nullif(d->>'salt_streaming_film', '') is not null then 1 else 0 end)
    + (case when nullif(d->>'salt_streaming_sport', '') is not null then 1 else 0 end)
    + (case when d->>'salt_trygghet' = 'true' then 1 else 0 end))
$$;

do $$
declare f text := 'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'; v text;
  a text := '''merAnBredband'', (select count(*) from salda where mer),';
begin
  v := pg_get_functiondef(f::regprocedure);
  if position('antalAvtal' in v) > 0 then return; end if;
  if position(a in v) = 0 then raise exception 'hittar inte merAnBredband'; end if;
  execute replace(v, a, a || '
      ''antalAvtal'', (select jsonb_build_object(
          ''1'', count(*) filter (where n = 1), ''2'', count(*) filter (where n = 2),
          ''3'', count(*) filter (where n = 3), ''4'', count(*) filter (where n = 4),
          ''5'', count(*) filter (where n = 5), ''6+'', count(*) filter (where n >= 6))
        from (select d2d_antal_avtal(d) n from salda) x),');
end $$;

-- 2. Nytt: summa avtal totalt och per säljare.
do $$
declare f text := 'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'; v text;
  a text := '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer) order by salda desc, besok desc)';
  b text := 'count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer) mer';
  c text := '''merAnBredband'', (select count(*) from salda where mer),';
begin
  v := pg_get_functiondef(f::regprocedure);
  if position('avtalSumma' in v) > 0 then return; end if;
  if position(a in v) = 0 then raise exception 'hittar inte perSaljare-objektet'; end if;
  if position(b in v) = 0 then raise exception 'hittar inte perSaljare-aggregatet'; end if;
  if position(c in v) = 0 then raise exception 'hittar inte merAnBredband'; end if;
  v := replace(v, a, '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal) order by salda desc, besok desc)');
  v := replace(v, b, b || ',
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0) avtal');
  v := replace(v, c, c || '
      ''avtalSumma'', (select coalesce(sum(d2d_antal_avtal(d)), 0) from salda),');
  execute v;
end $$;
