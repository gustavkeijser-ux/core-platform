-- =====================================================================
--  D2D: mejl till säljaren när kundtjänst lämnar en affär (Gustav 2026-10-15)
--
--  d2d_kundtjanst_lamna lägger en rad i kön d2d_kundtjanst_notis och anropar
--  edge function d2d-kundtjanst-notis direkt (pg_net, efter commit). Funktionen
--  hämtar underlaget (d2d_kundtjanst_notis_underlag), skickar ett mejl via
--  Microsoft Graph från ärendebrevlådan till säljarens e-post (users.email) med
--  kund, adress, telefon, meddelandet från kundtjänst och en knapp till kundkortet
--  i D2D-sälj, och markerar raden (d2d_kundtjanst_notis_klar).
--  Reserv: pg_cron var 5:e minut tar rader som inte gått iväg (max 5 försök, 24 h).
--  Skydd: x-cron-token mot vault-hemligheten mail_sync_cron_token.
-- =====================================================================

create table if not exists public.d2d_kundtjanst_notis (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  lagenhet_id uuid not null,
  saljare_id uuid not null,
  kundtjanst_id uuid,
  meddelande text,
  skapad_at timestamptz not null default now(),
  skickad_at timestamptz,
  forsok int not null default 0,
  fel text
);
create index if not exists d2d_kundtjanst_notis_vantar on public.d2d_kundtjanst_notis (skapad_at) where skickad_at is null;
alter table public.d2d_kundtjanst_notis enable row level security;
-- Ingen policy: bara security definer-funktioner och service role läser och skriver.
revoke all on public.d2d_kundtjanst_notis from public, anon, authenticated;

-- Underlag: väntande rader med allt mejlet behöver. Bara service role.
create or replace function public.d2d_kundtjanst_notis_underlag()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'tenantId', n.tenant_id, 'lagenhetId', n.lagenhet_id,
      'saljare', coalesce(nullif(s.full_name, ''), split_part(s.email::text, '@', 1)),
      'saljareEpost', s.email,
      'kundtjanst', coalesce(nullif(k.full_name, ''), split_part(k.email::text, '@', 1)),
      'meddelande', n.meddelande,
      'kund', l.data->>'kund_namn', 'telefon', l.data->>'kund_telefon', 'epost', l.data->>'kund_epost',
      'adress', concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer'), 'lgh', l.title,
      'pinnar', round(d2d_pinnar(l.data, d2d_lonemodell_for(n.tenant_id)), 1),
      'lamnad', n.skapad_at) order by n.skapad_at), '[]'::jsonb)
    from d2d_kundtjanst_notis n
    join users s on s.id = n.saljare_id
    left join users k on k.id = n.kundtjanst_id
    join records l on l.id = n.lagenhet_id and l.deleted_at is null
   where n.skickad_at is null and n.forsok < 5 and n.skapad_at > now() - interval '24 hours'
$$;
revoke all on function public.d2d_kundtjanst_notis_underlag() from public, anon, authenticated;

create or replace function public.d2d_kundtjanst_notis_klar(p_rader jsonb)
 returns void language plpgsql security definer set search_path to 'public' as $$
declare x jsonb;
begin
  for x in select * from jsonb_array_elements(coalesce(p_rader, '[]'::jsonb)) loop
    update d2d_kundtjanst_notis
       set forsok = forsok + 1,
           skickad_at = case when coalesce(x->>'fel', '') = '' then now() else skickad_at end,
           fel = nullif(x->>'fel', '')
     where id = (x->>'id')::uuid;
  end loop;
end $$;
revoke all on function public.d2d_kundtjanst_notis_klar(jsonb) from public, anon, authenticated;

-- Väcker edge function direkt (pg_net skickar efter commit).
create or replace function public.d2d_kundtjanst_notis_vack()
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-kundtjanst-notis',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
exception when others then null;  -- notisen får aldrig stoppa överlämningen; cron tar den
end $$;
revoke all on function public.d2d_kundtjanst_notis_vack() from public, anon, authenticated;

-- Överlämningen lägger notisen i kön och väcker funktionen.
do $$
declare d text := pg_get_functiondef('public.d2d_kundtjanst_lamna'::regproc);
        a text := '  return jsonb_build_object(''ok'', true, ''saljare'', v_namn);';
begin
  if position('d2d_kundtjanst_notis' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'd2d_kundtjanst_lamna: oväntad text'; end if;
  execute replace(d, a,
'  insert into d2d_kundtjanst_notis (tenant_id, lagenhet_id, saljare_id, kundtjanst_id, meddelande)
  select v_t, r.id, p_saljare, v_uid, nullif(btrim(p_kommentar), '''')
   where not exists (select 1 from mail_accounts ma join users su on su.id = p_saljare
                      where ma.is_active and lower(ma.mailbox) = lower(su.email::text));  -- aldrig till ärendebrevlådan
  perform d2d_kundtjanst_notis_vack();

' || a);
end $$;

-- Reserv: var 5:e minut.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'd2d-kundtjanst-notis') then
    perform cron.schedule('d2d-kundtjanst-notis', '*/5 * * * *', $c$
      select net.http_post(
        url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-kundtjanst-notis',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000) as request_id
       where exists (select 1 from public.d2d_kundtjanst_notis where skickad_at is null and forsok < 5
                      and skapad_at > now() - interval '24 hours');
    $c$);
  end if;
end $$;
