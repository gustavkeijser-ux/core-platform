-- Ärendehantering: gemensam e-postsignatur.
--
-- En signatur per organisation som läggs till under ALLA svar som skickas
-- från ärendehanteringen (hyresgast@connectestate.se). Admin ställer in den
-- under Kundservice → E-post & signatur. Platshållare:
--   {namn}   → handläggarens namn
--   {e-post} → handläggarens e-post

create table if not exists public.mail_settings (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  signature  text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.mail_settings enable row level security;
-- Inga direkta policys: läsning/skrivning går via funktionerna nedan.

/** Signaturen med platshållarna ifyllda för en viss handläggare. */
create or replace function public.ce_mail_signature(p_tenant uuid, p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select nullif(trim(replace(replace(ms.signature,
           '{namn}', coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1), '')),
           '{e-post}', coalesce(u.email::text, ''))), '')
    from mail_settings ms
    left join users u on u.id = p_user
   where ms.tenant_id = p_tenant
$$;
revoke all on function public.ce_mail_signature(uuid, uuid) from public, anon, authenticated;

/** Signaturen (rå + förhandsvisning för inloggad användare) till ärendevyn. */
create or replace function public.get_mail_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ms mail_settings;
begin
  if not can_do('case', 'read') and not is_admin() then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  select * into ms from mail_settings where tenant_id = my_tenant_id();
  return jsonb_build_object(
    'signature', coalesce(ms.signature, ''),
    'preview', coalesce(public.ce_mail_signature(my_tenant_id(), auth.uid()), ''),
    'updatedAt', ms.updated_at,
    'updatedBy', (select coalesce(nullif(full_name, ''), email::text) from users where id = ms.updated_by),
    'canEdit', is_admin());
end $$;

/** Spara signaturen (bara admin). Tom text = ingen signatur. */
create or replace function public.set_mail_signature(p_signature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := trim(coalesce(p_signature, ''));
begin
  if not is_admin() then raise exception 'Bara administratörer kan ändra signaturen' using errcode = '42501'; end if;
  if length(v) > 2000 then raise exception 'Signaturen får vara högst 2000 tecken' using errcode = '22023'; end if;
  insert into mail_settings (tenant_id, signature, updated_at, updated_by)
  values (my_tenant_id(), v, now(), auth.uid())
  on conflict (tenant_id) do update set signature = excluded.signature, updated_at = now(), updated_by = auth.uid();
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, after)
  values (my_tenant_id(), 'user', auth.uid(), 'mail.signature_set', 'mail_settings', null, jsonb_build_object('signature', v));
  return get_mail_settings();
end $$;

grant execute on function public.get_mail_settings() to authenticated;
grant execute on function public.set_mail_signature(text) to authenticated;

/** Svar till kund — som i 0031, men med signaturen under texten. */
create or replace function public.case_queue_reply(p_case uuid, p_body text, p_next_status text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare c records; v_to text; v_id uuid; v_subject text; v_last communications; v_body text;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then
    raise exception 'Saknar behörighet att svara på ärendet' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Svaret är tomt' using errcode = '22023'; end if;
  if p_next_status is not null and not exists (
      select 1 from status_definitions sd join object_definitions od on od.id = sd.object_id
       where od.tenant_id = c.tenant_id and od.key = 'case' and sd.key = p_next_status) then
    raise exception 'Okänd status' using errcode = '22023';
  end if;

  select cm.* into v_last from communications cm join communication_links cl on cl.communication_id = cm.id
   where cl.record_id = p_case and cm.channel = 'email' and cm.direction = 'inbound'
   order by cm.occurred_at desc limit 1;
  v_to := coalesce(v_last.from_address, nullif(c.data->>'kund_epost', ''));
  if v_to is null then raise exception 'Ärendet saknar mottagare (kundens e-post)' using errcode = '22023'; end if;

  v_subject := coalesce(nullif(v_last.subject, ''), c.data->>'name');
  if position(c.data->>'case_number' in coalesce(v_subject, '')) = 0 then
    v_subject := v_subject || ' [' || (c.data->>'case_number') || ']';
  end if;

  -- Gemensam signatur (Kundservice → E-post & signatur) läggs alltid till
  -- under svaret. Sparas i meddelandet, så tråden i CRM:et visar exakt det
  -- kunden fick.
  v_body := trim(p_body);
  if coalesce(public.ce_mail_signature(c.tenant_id, auth.uid()), '') <> '' then
    v_body := v_body || E'\n\n' || public.ce_mail_signature(c.tenant_id, auth.uid());
  end if;

  insert into communications (tenant_id, channel, direction, provider, external_id, thread_key,
    subject, body_text, from_address, to_addresses, occurred_at, mailbox, conversation_id,
    in_reply_to, author_user_id, processing_status, send_status, headers)
  values (c.tenant_id, 'email', 'outbound', 'microsoft_graph', 'pending:' || gen_random_uuid(),
    v_last.conversation_id, v_subject, v_body,
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    array[v_to], now(),
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    v_last.conversation_id, v_last.internet_message_id, auth.uid(), 'done', 'pending',
    jsonb_build_object('replyToGraphId', v_last.external_id, 'nextStatus', p_next_status))
  returning id into v_id;

  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason, confirmed_at, confirmed_by)
  values (v_id, p_case, c.tenant_id, 1, 'user', 'Svar från CRM', now(), auth.uid());
  return v_id;
end $$;
