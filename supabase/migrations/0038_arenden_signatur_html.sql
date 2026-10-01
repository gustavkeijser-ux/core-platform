-- Ärendehantering: e-postsignatur med formatering och bilder (HTML).
--
-- 0037 gav en gemensam textsignatur. Här kan signaturen även vara HTML
-- (logotyp, färger, länkar) — exakt som i Outlook. Mejlet till kunden får
-- HTML-versionen; tråden i CRM:et visar en textversion av samma signatur.
-- Finns ingen HTML-signatur används textsignaturen som tidigare.
--
-- Bilder i signaturen måste ligga på en publik adress (mejlklienter hämtar
-- dem själva), t.ex. edge function mail-assets.

alter table public.mail_settings add column if not exists signature_html text not null default '';

/** Enkel HTML → text (samma regler som htmlToText i edge-funktionerna). */
create or replace function public.ce_html_to_text(p_html text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_html, ''),
        '<(script|style|head)[^>]*>.*?</\1>', '', 'gis'),
        '\s*\n\s*', ' ', 'g'),
        '<br\s*/?>', E'\n', 'gi'),
        '</(p|div|li|tr|h[1-6])>', E'\n', 'gi'),
      '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''),
    '<[^>]+>', '', 'g'),
    '[ \t]*\n[ \t\n]*', E'\n', 'g'), E' \n\t'), '')
$$;

/** HTML-escape för värden som sätts in i HTML-signaturen. */
create or replace function public.ce_html_escape(p text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

/** HTML-signaturen med {namn}/{e-post} ifyllda (tom = ingen HTML-signatur). */
create or replace function public.ce_mail_signature_html(p_tenant uuid, p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select nullif(trim(replace(replace(ms.signature_html,
           '{namn}', ce_html_escape(coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1), ''))),
           '{e-post}', ce_html_escape(coalesce(u.email::text, '')))), '')
    from mail_settings ms
    left join users u on u.id = p_user
   where ms.tenant_id = p_tenant
$$;
revoke all on function public.ce_mail_signature_html(uuid, uuid) from public, anon, authenticated;

/** Textsignaturen: textversionen av HTML-signaturen om en sådan finns. */
create or replace function public.ce_mail_signature(p_tenant uuid, p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    ce_html_to_text(ce_mail_signature_html(p_tenant, p_user)),
    (select nullif(trim(replace(replace(ms.signature,
              '{namn}', coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1), '')),
              '{e-post}', coalesce(u.email::text, ''))), '')
       from mail_settings ms left join users u on u.id = p_user
      where ms.tenant_id = p_tenant))
$$;
revoke all on function public.ce_mail_signature(uuid, uuid) from public, anon, authenticated;

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
    'signatureHtml', coalesce(ms.signature_html, ''),
    'preview', coalesce(public.ce_mail_signature(my_tenant_id(), auth.uid()), ''),
    'previewHtml', coalesce(public.ce_mail_signature_html(my_tenant_id(), auth.uid()), ''),
    'updatedAt', ms.updated_at,
    'updatedBy', (select coalesce(nullif(full_name, ''), email::text) from users where id = ms.updated_by),
    'canEdit', is_admin());
end $$;

drop function if exists public.set_mail_signature(text);
/** Spara signaturen (bara admin). p_signature_html null = lämna HTML-signaturen orörd. */
create or replace function public.set_mail_signature(p_signature text, p_signature_html text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := trim(coalesce(p_signature, '')); h text := trim(coalesce(p_signature_html, ''));
begin
  if not is_admin() then raise exception 'Bara administratörer kan ändra signaturen' using errcode = '42501'; end if;
  if length(v) > 2000 then raise exception 'Signaturen får vara högst 2000 tecken' using errcode = '22023'; end if;
  if length(h) > 20000 then raise exception 'HTML-signaturen får vara högst 20 000 tecken' using errcode = '22023'; end if;
  if h ~* '<\s*(script|iframe|object|embed|form)|\son\w+\s*=|javascript:' then
    raise exception 'HTML-signaturen innehåller otillåten kod (script, formulär eller händelser)' using errcode = '22023';
  end if;
  insert into mail_settings (tenant_id, signature, signature_html, updated_at, updated_by)
  values (my_tenant_id(), v, h, now(), auth.uid())
  on conflict (tenant_id) do update set
    signature = excluded.signature,
    signature_html = case when p_signature_html is null then mail_settings.signature_html else excluded.signature_html end,
    updated_at = now(), updated_by = auth.uid();
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, after)
  values (my_tenant_id(), 'user', auth.uid(), 'mail.signature_set', 'mail_settings', null,
          jsonb_build_object('signature', v, 'signatureHtml', case when p_signature_html is null then null else h end));
  return get_mail_settings();
end $$;
grant execute on function public.set_mail_signature(text, text) to authenticated;

/** Svar till kund: texten + textsignaturen i tråden; mejlet får HTML-signaturen
 *  (headers.replyText / headers.signatureHtml, läses av mail-send). */
create or replace function public.case_queue_reply(p_case uuid, p_body text, p_next_status text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare c records; v_to text; v_id uuid; v_subject text; v_last communications; v_body text; v_sig text; v_sig_html text;
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

  v_sig := public.ce_mail_signature(c.tenant_id, auth.uid());
  v_sig_html := public.ce_mail_signature_html(c.tenant_id, auth.uid());
  v_body := trim(p_body) || case when coalesce(v_sig, '') <> '' then E'\n\n' || v_sig else '' end;

  insert into communications (tenant_id, channel, direction, provider, external_id, thread_key,
    subject, body_text, from_address, to_addresses, occurred_at, mailbox, conversation_id,
    in_reply_to, author_user_id, processing_status, send_status, headers)
  values (c.tenant_id, 'email', 'outbound', 'microsoft_graph', 'pending:' || gen_random_uuid(),
    v_last.conversation_id, v_subject, v_body,
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    array[v_to], now(),
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    v_last.conversation_id, v_last.internet_message_id, auth.uid(), 'done', 'pending',
    jsonb_build_object('replyToGraphId', v_last.external_id, 'nextStatus', p_next_status)
      || case when v_sig_html is not null
              then jsonb_build_object('replyText', trim(p_body), 'signatureHtml', v_sig_html) else '{}'::jsonb end)
  returning id into v_id;

  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason, confirmed_at, confirmed_by)
  values (v_id, p_case, c.tenant_id, 1, 'user', 'Svar från CRM', now(), auth.uid());
  return v_id;
end $$;
