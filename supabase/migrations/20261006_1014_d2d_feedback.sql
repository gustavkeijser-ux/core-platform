-- Feedback från dörrsäljarna (fliken Feedback i Blitz, säljarvyn).
--
-- Säljaren skriver sin feedback i telefonen → den hamnar i d2d_feedback med
-- status 'vantar'. Granskaren (Lukas, tabellen d2d_feedback_granskare) ser kön
-- i CRM:et (Door to door → Säljarfeedback), kan redigera texten och godkänna
-- eller neka. Godkänd feedback läggs in i den vanliga tabellen feedback (så
-- den syns i menyn Feedback) och skickas till Teams av edge function
-- d2d-feedback-send. Säljaren ser status på sina egna inskick.

create table if not exists public.d2d_feedback (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  user_id          uuid references public.users(id) on delete set null,   -- säljaren
  text             text not null,
  page             text,
  status           text not null default 'vantar' check (status in ('vantar', 'godkand', 'nekad')),
  granskad_av      uuid references public.users(id) on delete set null,
  granskad_at      timestamptz,
  godkand_text     text,          -- texten som faktiskt skickades (Lukas kan ha redigerat)
  nekad_anledning  text,
  feedback_id      uuid references public.feedback(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists d2d_feedback_tenant_status on public.d2d_feedback (tenant_id, status, created_at desc);

alter table public.d2d_feedback enable row level security;
-- Säljaren ser sin egen; granskaren och administratörer ser all i organisationen.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'd2d_feedback' and policyname = 'd2d_feedback_read') then
    create policy d2d_feedback_read on public.d2d_feedback for select
      using (tenant_id = my_tenant_id() and (user_id = auth.uid() or is_admin()));
  end if;
end $$;

-- Vem granskar säljarnas feedback. Lukas och Gustav. Byt granskare genom att
-- ändra raderna här (ingen kod behöver ändras).
create table if not exists public.d2d_feedback_granskare (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid not null references public.users(id) on delete cascade,
  primary key (tenant_id, user_id)
);
alter table public.d2d_feedback_granskare enable row level security;
insert into public.d2d_feedback_granskare (tenant_id, user_id)
  select u.tenant_id, u.id from public.users u where u.email in ('lukas@connectestate.se', 'gustav@connectestate.se')
  on conflict do nothing;

/** Är den inloggade granskare av säljarfeedback? (Styr menyvalet i CRM:et.) */
create or replace function public.d2d_feedback_ar_granskare()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from d2d_feedback_granskare
                  where tenant_id = my_tenant_id() and user_id = auth.uid())
$$;
grant execute on function public.d2d_feedback_ar_granskare() to authenticated;

/** Säljaren skickar in feedback. Returnerar raden. */
create or replace function public.d2d_feedback_skicka(p_text text, p_page text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.d2d_feedback;
begin
  if my_tenant_id() is null or auth.uid() is null then
    raise exception 'Ej inloggad' using errcode = '42501';
  end if;
  if coalesce(trim(p_text), '') = '' then
    raise exception 'Skriv vad det gäller' using errcode = '22023';
  end if;
  if length(p_text) > 4000 then
    raise exception 'Feedbacken får vara högst 4000 tecken' using errcode = '22023';
  end if;
  insert into public.d2d_feedback (tenant_id, user_id, text, page)
  values (my_tenant_id(), auth.uid(), trim(p_text), left(p_page, 300))
  returning * into v;
  return to_jsonb(v);
end $$;
grant execute on function public.d2d_feedback_skicka(text, text) to authenticated;

/** Lista. Granskaren ser alla (väntande först), säljaren bara sina. */
create or replace function public.d2d_feedback_lista()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'text', f.text, 'page', f.page, 'status', f.status, 'createdAt', f.created_at,
      'granskadAt', f.granskad_at, 'godkandText', f.godkand_text, 'nekadAnledning', f.nekad_anledning,
      'granskadAv', (select coalesce(nullif(full_name, ''), email::text) from users where id = f.granskad_av),
      'saljare', jsonb_build_object('id', u.id, 'name', coalesce(nullif(u.full_name, ''), u.email::text, 'Okänd'), 'email', u.email),
      'min', (f.user_id = auth.uid())
    ) order by (f.status <> 'vantar'), f.created_at desc), '[]'::jsonb)
  from d2d_feedback f
  left join users u on u.id = f.user_id
  where f.tenant_id = my_tenant_id()
    and (f.user_id = auth.uid() or d2d_feedback_ar_granskare())
$$;
grant execute on function public.d2d_feedback_lista() to authenticated;

/** Antal som väntar på granskning (siffran i menyn hos granskaren). */
create or replace function public.d2d_feedback_antal_vantar()
returns integer language sql stable security definer set search_path = public as $$
  select case when d2d_feedback_ar_granskare()
    then (select count(*)::int from d2d_feedback where tenant_id = my_tenant_id() and status = 'vantar')
    else 0 end
$$;
grant execute on function public.d2d_feedback_antal_vantar() to authenticated;

/** Granskaren godkänner (med eventuellt redigerad text). Lägger in raden i
 *  feedback (avsändare = säljaren, modul Blitz) och returnerar den tillsammans
 *  med säljarens namn — edge function d2d-feedback-send skickar den till Teams. */
create or replace function public.d2d_feedback_godkann(p_id uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.d2d_feedback; f public.feedback; v_namn text;
begin
  if not d2d_feedback_ar_granskare() then
    raise exception 'Bara granskaren kan godkänna säljarfeedback' using errcode = '42501';
  end if;
  select * into d from d2d_feedback where id = p_id and tenant_id = my_tenant_id() for update;
  if not found then raise exception 'Feedbacken finns inte' using errcode = 'P0002'; end if;
  if d.status <> 'vantar' then raise exception 'Feedbacken är redan granskad' using errcode = '22023'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Texten får inte vara tom' using errcode = '22023'; end if;
  if length(p_text) > 4000 then raise exception 'Texten får vara högst 4000 tecken' using errcode = '22023'; end if;

  insert into public.feedback (tenant_id, user_id, category, module, priority, message, page)
  values (d.tenant_id, d.user_id, 'Säljarfeedback', 'Blitz', 'normal', trim(p_text), d.page)
  returning * into f;

  update d2d_feedback set status = 'godkand', granskad_av = auth.uid(), granskad_at = now(),
         godkand_text = trim(p_text), feedback_id = f.id
   where id = p_id;

  select coalesce(nullif(full_name, ''), email::text, 'Okänd säljare') into v_namn from users where id = d.user_id;
  return to_jsonb(f) || jsonb_build_object('saljare', v_namn,
    'granskare', (select coalesce(nullif(full_name, ''), email::text) from users where id = auth.uid()));
end $$;
grant execute on function public.d2d_feedback_godkann(uuid, text) to authenticated;

/** Granskaren nekar, med en kort anledning som säljaren ser. */
create or replace function public.d2d_feedback_neka(p_id uuid, p_anledning text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not d2d_feedback_ar_granskare() then
    raise exception 'Bara granskaren kan neka säljarfeedback' using errcode = '42501';
  end if;
  update d2d_feedback set status = 'nekad', granskad_av = auth.uid(), granskad_at = now(),
         nekad_anledning = left(nullif(trim(p_anledning), ''), 500)
   where id = p_id and tenant_id = my_tenant_id() and status = 'vantar';
  if not found then raise exception 'Feedbacken finns inte eller är redan granskad' using errcode = 'P0002'; end if;
end $$;
grant execute on function public.d2d_feedback_neka(uuid, text) to authenticated;
