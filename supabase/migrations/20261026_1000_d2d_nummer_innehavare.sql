-- D2D: vem står på numret vid tillfälligt nummer (Gustav 26 okt 2026). Varje nummerrad
-- (huvudnummer och extraanvändare) anger om kunden själv eller en annan person står på numret
-- (mobil_nummer.rows[].innehavare = 'kund' | 'annan'). Annan person kräver namn (agare),
-- personnummer (agare_pnr) och e-post (agare_epost). Nummerbytesärendet skapas först när
-- raderna är kompletta. Äldre rader utan innehavare räknas som förut (namn räcker).
create or replace function public.nb_complete(p_data jsonb)
returns boolean language sql immutable as $$
  select coalesce(p_data->>'mobil_startdatum', '') <> ''
     and jsonb_typeof(p_data->'mobil_nummer'->'rows') = 'array'
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'huvud')
         >= greatest(1, (select count(*) from public.d2d_mobil_enheter(p_data)))
     and (select count(*) from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n where n->>'typ' = 'extra')
         >= case when d2d_arr(p_data->'salt_mobil') ? 'extra_anvandare' then public.d2d_extra_antal(p_data) else 0 end
     and not exists (
       select 1 from jsonb_array_elements(p_data->'mobil_nummer'->'rows') n
        where coalesce(trim(n->>'riktigt'), '') = ''
           or case coalesce(n->>'innehavare', '')
                when 'kund' then false
                when 'annan' then coalesce(trim(n->>'agare'), '') = ''
                               or length(regexp_replace(coalesce(n->>'agare_pnr', ''), '\D', '', 'g')) not in (10, 12)
                               or coalesce(trim(n->>'agare_epost'), '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
                else coalesce(trim(n->>'agare'), '') = ''
              end)
$$;
