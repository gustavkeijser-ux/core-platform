-- Ärendehantering v1 – drift för mejlsynken: lås, omförsökskö, cron.

-- Lås per brevlåda så två överlappande körningar inte arbetar samtidigt.
alter table public.mail_accounts add column if not exists sync_lease_until timestamptz;

create or replace function public.mail_acquire_lease(p_account uuid, p_seconds int default 120)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update mail_accounts set sync_lease_until = now() + make_interval(secs => p_seconds)
     where id = p_account and (sync_lease_until is null or sync_lease_until < now())
    returning 1)
  select exists (select 1 from u)
$$;
create or replace function public.mail_release_lease(p_account uuid)
returns void language sql security definer set search_path = public as $$
  update mail_accounts set sync_lease_until = null where id = p_account
$$;

-- Meddelanden som inte gick att hämta från Graph — försöks igen (max 10 gånger).
create table if not exists public.mail_fetch_failures (
  account_id      uuid not null references public.mail_accounts(id) on delete cascade,
  graph_id        text not null,
  folder          text not null,
  attempts        int  not null default 1,
  last_error      text,
  first_failed_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  primary key (account_id, graph_id)
);
alter table public.mail_fetch_failures enable row level security;
drop policy if exists admin_read on public.mail_fetch_failures;
create policy admin_read on public.mail_fetch_failures for select using (is_admin() and exists (
  select 1 from mail_accounts a where a.id = account_id and a.tenant_id = my_tenant_id()));
grant select on public.mail_fetch_failures to authenticated;

create or replace function public.mail_fetch_failed(p_account uuid, p_graph_id text, p_folder text, p_error text)
returns void language sql security definer set search_path = public as $$
  insert into mail_fetch_failures (account_id, graph_id, folder, last_error)
  values (p_account, p_graph_id, p_folder, left(p_error, 1000))
  on conflict (account_id, graph_id) do update
     set attempts = mail_fetch_failures.attempts + 1, last_error = excluded.last_error, last_attempt_at = now()
$$;

-- Sändningslås: ett svar kan bara skickas av ett anrop åt gången.
alter table public.communications add column if not exists send_claimed_at timestamptz;
create or replace function public.mail_claim_send(p_comm uuid)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update communications set send_claimed_at = now(), send_status = 'sending'
     where id = p_comm and direction = 'outbound' and channel = 'email'
       and send_status in ('pending', 'failed', 'sending')
       and (send_claimed_at is null or send_claimed_at < now() - interval '2 minutes')
    returning 1)
  select exists (select 1 from u)
$$;

-- Cron-token i Vault (aldrig i cron-jobbets text eller i koden).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'mail_sync_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'mail_sync_cron_token',
                                'Token som pg_cron använder mot edge function mail-sync');
  end if;
end $$;

create or replace function public.mail_check_cron_token(p_token text)
returns boolean language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets
                  where name = 'mail_sync_cron_token' and decrypted_secret = p_token)
$$;

-- Aggregat för den öppna adminvyn: antal meddelanden i omförsökskön.
create or replace function public.mail_failure_count(p_account uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from mail_fetch_failures where account_id = p_account and attempts < 10
$$;

revoke all on function public.mail_acquire_lease(uuid, int), public.mail_release_lease(uuid),
  public.mail_fetch_failed(uuid, text, text, text), public.mail_claim_send(uuid),
  public.mail_check_cron_token(text), public.mail_failure_count(uuid)
  from public, anon, authenticated;
grant execute on function public.mail_acquire_lease(uuid, int), public.mail_release_lease(uuid),
  public.mail_fetch_failed(uuid, text, text, text), public.mail_claim_send(uuid),
  public.mail_check_cron_token(text), public.mail_failure_count(uuid)
  to service_role;

-- Adminstatus: lägg till omförsökskön.
create or replace function public.mail_integration_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'mailbox', a.mailbox, 'isActive', a.is_active, 'importFrom', a.import_from,
      'folders', coalesce((select jsonb_agg(jsonb_build_object(
          'folder', s.folder, 'lastSuccessAt', s.last_success_at, 'lastError', s.last_error,
          'lastErrorAt', s.last_error_at, 'consecutiveFailures', s.consecutive_failures,
          'messagesImported', s.messages_imported, 'hasDelta', s.delta_link is not null))
        from mail_sync_state s where s.account_id = a.id), '[]'::jsonb),
      'lastRun', (select to_jsonb(ir) - 'tenant_id' from integration_runs ir where ir.account_id = a.id
                   order by ir.started_at desc limit 1),
      'lastOkRun', (select max(finished_at) from integration_runs ir where ir.account_id = a.id and ir.status = 'ok'),
      'lastError', (select jsonb_build_object('at', ir.started_at, 'error', ir.error) from integration_runs ir
                     where ir.account_id = a.id and ir.status = 'error' order by ir.started_at desc limit 1),
      'runs24h', (select count(*) from integration_runs ir where ir.account_id = a.id and ir.started_at > now() - interval '24 hours'),
      'errors24h', (select count(*) from integration_runs ir where ir.account_id = a.id and ir.status = 'error'
                     and ir.started_at > now() - interval '24 hours'),
      'imported', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.provider = 'microsoft_graph'
                    and c.mailbox = a.mailbox::text and c.direction = 'inbound'),
      'casesFromEmail', (select count(*) from records r where r.tenant_id = a.tenant_id and r.object_type = 'case'
                          and r.deleted_at is null and r.data->>'mailbox' = a.mailbox::text),
      'retryQueue', (select count(*) from mail_fetch_failures f where f.account_id = a.id and f.attempts < 10),
      'failedProcessing', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.provider = 'microsoft_graph'
                            and c.processing_status = 'failed'),
      'failedSends', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.send_status = 'failed')))
    from mail_accounts a where a.tenant_id = my_tenant_id()), '[]'::jsonb);
end $$;

-- Synk varje minut.
select cron.unschedule(jobid) from cron.job where jobname = 'mail-sync-varje-minut';
select cron.schedule('mail-sync-varje-minut', '* * * * *', $cron$
  select net.http_post(
    url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000) as request_id;
$cron$);

-- Första riktiga synken (när Microsoft 365 kopplats in) importerar bara mejl
-- från och med kopplingen — ingen flod av gamla, redan hanterade mejl.
create or replace function public.mail_first_run_init(p_account uuid)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  update mail_accounts set import_from = now()
   where id = p_account and not exists (select 1 from mail_sync_state s where s.account_id = p_account);
  select import_from into v from mail_accounts where id = p_account;
  return v;
end $$;
revoke all on function public.mail_first_run_init(uuid) from public, anon, authenticated;
grant execute on function public.mail_first_run_init(uuid) to service_role;
