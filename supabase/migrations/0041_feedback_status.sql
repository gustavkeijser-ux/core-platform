-- Feedback: status (ny / pågående / klar) och en lista för administratörer
-- (menyn Övrigt → Feedback). Visar vem som skickat in varje rad.

alter table public.feedback add column if not exists status text not null default 'new'
  check (status in ('new', 'in_progress', 'done'));
alter table public.feedback add column if not exists status_changed_at timestamptz;
alter table public.feedback add column if not exists status_changed_by uuid references public.users(id) on delete set null;

/** Feedback med avsändare. Admin ser all, andra bara sin egen. */
create or replace function public.list_feedback(p_status text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'category', f.category, 'module', f.module, 'priority', f.priority,
      'message', f.message, 'page', f.page, 'createdAt', f.created_at,
      'status', f.status, 'statusChangedAt', f.status_changed_at,
      'statusChangedBy', (select coalesce(nullif(full_name, ''), email::text) from users where id = f.status_changed_by),
      'teamsStatus', f.teams_status,
      'sender', jsonb_build_object('id', u.id, 'name', coalesce(nullif(u.full_name, ''), u.email::text, 'Okänd'), 'email', u.email)
    ) order by (f.status = 'done'), f.created_at desc), '[]'::jsonb)
  from feedback f
  left join users u on u.id = f.user_id
  where f.tenant_id = my_tenant_id()
    and (is_admin() or f.user_id = auth.uid())
    and (p_status is null or f.status = p_status)
$$;
grant execute on function public.list_feedback(text) to authenticated;

/** Sätt status (bara admin). */
create or replace function public.set_feedback_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara administratörer kan ändra status' using errcode = '42501'; end if;
  if p_status not in ('new', 'in_progress', 'done') then raise exception 'Okänd status' using errcode = '22023'; end if;
  update feedback set status = p_status, status_changed_at = now(), status_changed_by = auth.uid()
   where id = p_id and tenant_id = my_tenant_id();
  if not found then raise exception 'Feedbacken finns inte' using errcode = 'P0002'; end if;
end $$;
grant execute on function public.set_feedback_status(uuid, text) to authenticated;
