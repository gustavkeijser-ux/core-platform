-- Feedback från användarna (knappen längst ned till höger i CRM:et).
--
-- Varje feedback sparas här och skickas sedan till Teams av edge function
-- feedback-send (via en Teams-arbetsflödes-webhook, secret
-- TEAMS_FEEDBACK_WEBHOOK_URL). Sparas alltid, även om Teams inte svarar,
-- så att inget försvinner.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  category    text not null,
  module      text not null,
  priority    text not null check (priority in ('low', 'normal', 'high', 'critical')),
  message     text not null,
  page        text,
  created_at  timestamptz not null default now(),
  teams_status text not null default 'pending' check (teams_status in ('pending', 'sent', 'failed', 'not_configured')),
  teams_error  text
);
create index if not exists feedback_tenant_created on public.feedback (tenant_id, created_at desc);

alter table public.feedback enable row level security;
-- Man ser sin egen feedback; administratörer ser all i organisationen.
create policy feedback_read on public.feedback for select
  using (tenant_id = my_tenant_id() and (user_id = auth.uid() or is_admin()));

/** Spara en feedback (alla inloggade). Returnerar raden. */
create or replace function public.submit_feedback(
  p_category text, p_module text, p_priority text, p_message text, p_page text default null)
returns public.feedback language plpgsql security definer set search_path = public as $$
declare v public.feedback;
begin
  if my_tenant_id() is null or auth.uid() is null then
    raise exception 'Ej inloggad' using errcode = '42501';
  end if;
  if coalesce(trim(p_message), '') = '' then
    raise exception 'Skriv vad det gäller' using errcode = '22023';
  end if;
  if length(p_message) > 4000 then
    raise exception 'Feedbacken får vara högst 4000 tecken' using errcode = '22023';
  end if;
  if p_priority not in ('low', 'normal', 'high', 'critical') then
    raise exception 'Okänd prioritet' using errcode = '22023';
  end if;
  insert into public.feedback (tenant_id, user_id, category, module, priority, message, page)
  values (my_tenant_id(), auth.uid(), left(trim(coalesce(p_category, 'Övrigt')), 80),
          left(trim(coalesce(p_module, 'Övrigt')), 80), p_priority, trim(p_message), left(p_page, 300))
  returning * into v;
  return v;
end $$;
grant execute on function public.submit_feedback(text, text, text, text, text) to authenticated;
