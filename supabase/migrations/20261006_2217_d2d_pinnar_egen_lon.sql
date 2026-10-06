-- Blitz: säljaren ser sin egen lön (pinnar × kr/pinne + bonus + justeringar)
-- på sitt pinnkort och sin profil. d2d_pinnar_oversikt får fältet minLon för
-- den inloggade; andras lönebelopp skickas fortfarande aldrig till Blitz.

create or replace function public.d2d_pinnar_oversikt(p_manad date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_m date := coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date);
        v jsonb;
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v := d2d_lon_manad(my_tenant_id(), v_m, false);
  return (v - 'krPerPinne') || jsonb_build_object(
    'saljare', (select coalesce(jsonb_agg(s - 'provision' - 'provisionInklVantar' - 'justeringar' - 'lon' - 'lonInklVantar'), '[]'::jsonb)
                  from jsonb_array_elements(v->'saljare') s),
    -- Den inloggades egen lön (andras lön visas aldrig i Blitz).
    'minLon', (select jsonb_build_object('provision', s->'provision', 'bonus', s->'bonus', 'justeringar', s->'justeringar',
                                         'lon', s->'lon', 'lonInklVantar', s->'lonInklVantar', 'krPerPinne', v->'krPerPinne')
                 from jsonb_array_elements(v->'saljare') s where s->>'id' = auth.uid()::text),
    'trappa', d2d_lonemodell_for(my_tenant_id())->'trappa', 'jag', auth.uid());
end $$;
grant execute on function public.d2d_pinnar_oversikt(date) to authenticated;
