-- =====================================================================
--  0067 — Utfall: TV Start och TV Bas räknas inte som TV-försäljning.
--  Bara TV-paket utöver dem (TV Mini, Mellan, Mycket) räknas som TV, både
--  i TV-raden och i "köpte mer än bredband". En kund med bara TV Start/Bas
--  räknas alltså som "enbart bredband" (och AI läser då kommentaren).
--  OBS: nyckeln tv_basic har etiketten "TV Bas", tv_bas är "TV Mini".
-- =====================================================================

create or replace function public.d2d_tv_raknas(d jsonb)
returns boolean language sql immutable as $$
  select coalesce(nullif(d->>'salt_tv', '') is not null
                  and d->>'salt_tv' not in ('tv_start', 'tv_basic'), false)
$$;

do $$
declare f text; v text;
begin
  foreach f in array array['public.d2d_mer_an_bredband(jsonb)', 'public.d2d_utfall(uuid, uuid, date, date)',
                           'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'] loop
    v := pg_get_functiondef(f::regprocedure);
    if position('d2d_tv_raknas' in v) > 0 then continue; end if;
    if position('nullif(d->>''salt_tv'', '''') is not null' in v) = 0 then
      raise exception '%: hittar inte salt_tv-villkoret', f;
    end if;
    execute replace(v, 'nullif(d->>''salt_tv'', '''') is not null', 'd2d_tv_raknas(d)');
  end loop;
end $$;
