-- =====================================================================
--  0069 — Utfall: hur många avtal (tjänster) varje kund signerat,
--  uppdelat 1, 2, 3, 4, 5 och 6+.
--  Ett avtal = en tjänst: bredband, TV (utöver Start/Bas), varje
--  huvudabonnemang på mobil, varje extraanvändare, streaming film,
--  streaming sport och trygghetspaket. Samma regler som "Sålda tjänster".
-- =====================================================================

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
