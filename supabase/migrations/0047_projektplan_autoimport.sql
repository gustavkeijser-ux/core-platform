-- Automatisk import av projektplanen (Projektplan CE.xlsx på SharePoint)
-- varje timme via edge function projektplan-import. Filen uppdateras från
-- Telias projektplan av en separat synk; importen hoppar över körningen om
-- filen inte ändrats sedan senaste lyckade import.

create table if not exists public.projektplan_import (
  id         uuid primary key default gen_random_uuid(),
  tid        timestamptz not null default now(),
  kalla      text not null check (kalla in ('auto', 'manuell')),
  status     text not null check (status in ('ok', 'oforandrad', 'fel')),
  fil_andrad timestamptz,
  ctag       text,
  rader      integer,
  resultat   jsonb,
  fel        text
);
create index if not exists projektplan_import_tid_idx on public.projektplan_import (tid desc);
alter table public.projektplan_import enable row level security;

/** Senaste körningarna för Import-sidan (admin). */
create or replace function public.projektplan_import_status(p_antal integer default 10)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Åtkomst nekad' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'senaste', coalesce((select jsonb_agg(to_jsonb(x) order by x.tid desc) from (
        select tid, kalla, status, fil_andrad, rader, resultat, fel
          from projektplan_import order by tid desc limit greatest(1, least(p_antal, 50))) x), '[]'::jsonb),
    'senastOk', (select to_jsonb(y) from (
        select tid, kalla, fil_andrad, rader, resultat from projektplan_import
         where status = 'ok' order by tid desc limit 1) y),
    'schema', (select schedule from cron.job where jobname = 'projektplan-autoimport'));
end $$;
grant execute on function public.projektplan_import_status(integer) to authenticated;

-- Varje timme, 20 minuter över (synken från Telia körs fem över).
do $$ begin
  if exists (select 1 from cron.job where jobname = 'projektplan-autoimport') then
    perform cron.unschedule('projektplan-autoimport');
  end if;
  perform cron.schedule('projektplan-autoimport', '20 * * * *', $cron$
    select net.http_post(
      url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/projektplan-import',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000)
  $cron$);
end $$;
