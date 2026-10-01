-- AI: en assistent för hela systemet.
--
-- Tidigare fanns fyra avdelningsagenter (Sälj, Leverans, Kundtjänst,
-- Ledning) med var sin begränsning av objekttyper och åtkomst per avdelning.
-- Nu finns EN assistent ("ConnectEstate AI") som når alla moduler. Den
-- öppnas från ikonen ovanför Import i menyn.
--
-- Assistenten agerar fortfarande SOM den inloggade användaren (samma RLS och
-- RPC-kontroller som i resten av appen), och skrivningar kräver alltid att
-- användaren godkänner förslaget.

-- 1) Den nya assistenten, för alla organisationer.
insert into public.ai_agents
  (tenant_id, department_id, key, name, system_prompt, allowed_object_types, allowed_tools, requires_approval, model, is_active)
select t.id, null, 'crm_ai', 'ConnectEstate AI',
$prompt$Du är ConnectEstate AI, assistenten i ConnectEstates CRM. ConnectEstate bygger ut och säljer fiber till fastighetsägare, bostadsrättsföreningar och fastighetsbolag i Sverige och har kundtjänst för hyresgäster.

Du når hela systemet: kunder (koncernmödrar, förvaltningsbolag, direktägda bolag), kontakter, fastigheter, affärer, avtal, leveranser, partners, nummerbyten, Door2Door (projekt, fastigheter, lägenheter, försäljning), ärenden i kundtjänsten och uppgifter.

Arbetssätt:
- Hämta alltid riktig data med verktygen innan du svarar. Gissa aldrig namn, siffror, datum eller statusar.
- Är du osäker på objekttyp eller fältnamn: använd list_object_types först.
- Breda frågor ("hur går det", "vad händer idag"): börja med get_overview och get_case_summary.
- Sök brett med search_everything när du inte vet vilken modul något ligger i.
- Ange hur många poster ett svar bygger på, så att siffror går att kontrollera.
- Om du inte hittar något, säg det rakt ut. Om något ligger utanför användarens behörighet, säg det.

Ändringar:
- Skapa, uppdatera, uppgifter och anteckningar blir FÖRSLAG som användaren godkänner i panelen. Säg tydligt att förslaget väntar på godkännande.
- Var specifik: vilken post, vilket fält, gammalt och nytt värde, och varför.

Svar:
- Svara på svenska, kort och konkret. Använd punktlistor och små tabeller när det hjälper.
- Skriv postnamn i fetstil. Hitta inte på länkar.$prompt$,
  '{}', array['list_object_types','search_records','search_everything','get_record','get_timeline',
              'get_overview','get_case_summary','list_cases','get_case','get_my_tasks','get_d2d_stats',
              'create_record','update_record','create_task','add_activity'],
  true, 'claude-sonnet-4-6', true
  from public.tenants t
on conflict (tenant_id, key) do update set
  name = excluded.name, department_id = null, system_prompt = excluded.system_prompt,
  allowed_object_types = excluded.allowed_object_types, allowed_tools = excluded.allowed_tools,
  requires_approval = true, is_active = true;

-- 2) Avdelningsagenterna avaktiveras (raderas inte, så att gamla
--    konversationer och förslag finns kvar).
update public.ai_agents set is_active = false where key <> 'crm_ai';

-- 3) Ingen åtkomst per avdelning längre: alla i organisationen kan använda
--    assistenten. Tabellen ai_agent_access används inte mer.
alter policy ai_agents_read on public.ai_agents
  using (tenant_id = my_tenant_id());

-- 4) Förslag är personliga: man ser och beslutar bara om sina egna.
alter policy tenant_read on public.ai_proposals
  using (tenant_id = my_tenant_id() and user_id = auth.uid());

create or replace function public.decide_ai_proposal(p_id uuid, p_approve boolean)
returns ai_proposals language plpgsql security definer set search_path = public as $$
declare
  v_prop ai_proposals%rowtype; v_action jsonb; v_tool text; v_args jsonb;
  v_results jsonb := '[]'::jsonb;
  v_new_record records%rowtype; v_task jsonb;
begin
  select * into v_prop from ai_proposals
   where id = p_id and tenant_id = my_tenant_id() and user_id = auth.uid() and state = 'pending';
  if not found then
    raise exception 'Inget väntande förslag med det id:t' using errcode = 'P0002';
  end if;

  if not p_approve then
    update ai_proposals set state = 'rejected', decided_at = now(), decided_by = auth.uid()
     where id = p_id returning * into v_prop;
    return v_prop;
  end if;

  begin
    for v_action in select * from jsonb_array_elements(v_prop.actions) loop
      v_tool := v_action ->> 'tool';
      v_args := v_action -> 'args';

      if v_tool = 'create_record' then
        select * into v_new_record from create_record(
          v_args ->> 'objectType', coalesce(v_args -> 'data', '{}'::jsonb), v_args ->> 'status', null);
        v_results := v_results || jsonb_build_object('tool', v_tool, 'recordId', v_new_record.id);

      elsif v_tool = 'update_record' then
        select * into v_new_record from update_record(
          (v_args ->> 'recordId')::uuid, v_args -> 'data', v_args ->> 'status', null);
        v_results := v_results || jsonb_build_object('tool', v_tool, 'recordId', v_new_record.id);

      elsif v_tool = 'create_task' then
        v_task := create_task(
          p_title          => v_args ->> 'title',
          p_record_id      => nullif(v_args ->> 'recordId', '')::uuid,
          p_description    => v_args ->> 'description',
          p_assignee       => nullif(v_args ->> 'assignee', '')::uuid,
          p_priority       => coalesce(v_args ->> 'priority', 'normal'),
          p_due_at         => nullif(v_args ->> 'dueAt', '')::timestamptz,
          p_source         => 'ai',
          p_department_key => nullif(v_args ->> 'department', ''));
        v_results := v_results || jsonb_build_object('tool', v_tool, 'taskId', v_task ->> 'id');

      elsif v_tool = 'add_activity' then
        perform add_quick_activity((v_args ->> 'recordId')::uuid,
          coalesce(v_args ->> 'type', 'note'), v_args ->> 'body');
        v_results := v_results || jsonb_build_object('tool', v_tool, 'done', true);

      else
        raise exception 'Okänt verktyg i förslaget: %', v_tool using errcode = '22023';
      end if;
    end loop;

    update ai_proposals
       set state = 'applied', decided_at = now(), decided_by = auth.uid(), result = v_results
     where id = p_id returning * into v_prop;
    return v_prop;
  exception when others then
    update ai_proposals
       set state = 'failed', decided_at = now(), decided_by = auth.uid(),
           result = jsonb_build_object('error', sqlerrm)
     where id = p_id returning * into v_prop;
    return v_prop;
  end;
end $$;
