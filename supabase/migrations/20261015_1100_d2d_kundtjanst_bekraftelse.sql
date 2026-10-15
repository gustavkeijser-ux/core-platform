-- =====================================================================
--  D2D: bekräftelse till ärendebrevlådan när en kundtjänstaffär signeras (Gustav 2026-10-15)
--
--  När en adress med data.kundtjanst blir Såld eller Signerad (Scrive) för första
--  gången läggs en rad (typ 'bekraftelse') i kön d2d_kundtjanst_notis och edge
--  function d2d-kundtjanst-notis väcks. Mejlet skickas FRÅN säljarens brevlåda TILL
--  ärendebrevlådan (hyresgast@) så att mail-sync tar in det som inkommande och skapar
--  ett ärende (ett mejl från brevlådan till sig själv räknas som utgående och ignoreras).
--  Nekar Microsoft det läggs mejlet in direkt via mail_ingest_message (blir ärende ändå).
--  En bekräftelse per adress (unikt index). Felet stoppar aldrig försäljningen.
-- =====================================================================

alter table public.d2d_kundtjanst_notis add column if not exists typ text not null default 'saljare';
alter table public.d2d_kundtjanst_notis add column if not exists status text;
create unique index if not exists d2d_kundtjanst_notis_bekraftelse_en on public.d2d_kundtjanst_notis (lagenhet_id) where typ = 'bekraftelse';

create or replace function public.d2d_kundtjanst_notis_underlag()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'typ', n.typ, 'status', n.status, 'tenantId', n.tenant_id, 'lagenhetId', n.lagenhet_id,
      'saljare', coalesce(nullif(s.full_name, ''), split_part(s.email::text, '@', 1)),
      'saljareEpost', s.email,
      'kundtjanst', coalesce(nullif(k.full_name, ''), split_part(k.email::text, '@', 1)),
      'meddelande', n.meddelande,
      'kund', l.data->>'kund_namn', 'telefon', l.data->>'kund_telefon', 'epost', l.data->>'kund_epost',
      'adress', concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer'), 'lgh', l.title,
      'pinnar', round(d2d_pinnar(l.data, d2d_lonemodell_for(n.tenant_id)), 1),
      'produkter', (select coalesce(jsonb_agg(r->>'nyckel'), '[]'::jsonb) from jsonb_array_elements(d2d_pinnar_rader(l.data, d2d_lonemodell_for(n.tenant_id))) r),
      'lamnad', n.skapad_at) order by n.skapad_at), '[]'::jsonb)
    from d2d_kundtjanst_notis n
    join users s on s.id = n.saljare_id
    left join users k on k.id = n.kundtjanst_id
    join records l on l.id = n.lagenhet_id and l.deleted_at is null
   where n.skickad_at is null and n.forsok < 5 and n.skapad_at > now() - interval '24 hours'
$$;
revoke all on function public.d2d_kundtjanst_notis_underlag() from public, anon, authenticated;

create or replace function public.d2d_kundtjanst_bekraftelse_trg()
 returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.object_type = 'd2d_lagenhet'
     and new.status in ('sald', 'scrive') and coalesce(old.status, '') not in ('sald', 'scrive')
     and nullif(new.data->>'kundtjanst', '') is not null
     and nullif(new.data->>'saljare', '') ~* '^[0-9a-f-]{36}$' then
    begin
      insert into d2d_kundtjanst_notis (tenant_id, lagenhet_id, saljare_id, kundtjanst_id, typ, status)
      values (new.tenant_id, new.id, (new.data->>'saljare')::uuid,
              case when new.data->>'kundtjanst' ~* '^[0-9a-f-]{36}$' then (new.data->>'kundtjanst')::uuid end,
              'bekraftelse', new.status)
      on conflict do nothing;
      if found then perform d2d_kundtjanst_notis_vack(); end if;
    exception when others then null;  -- bekräftelsen får aldrig stoppa en försäljning
    end;
  end if;
  return null;
end $$;
revoke all on function public.d2d_kundtjanst_bekraftelse_trg() from public, anon, authenticated;
create or replace trigger d2d_kundtjanst_bekraftelse after update of status on public.records
  for each row when (new.object_type = 'd2d_lagenhet' and new.status in ('sald', 'scrive'))
  execute function public.d2d_kundtjanst_bekraftelse_trg();
