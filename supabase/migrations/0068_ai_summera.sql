-- =====================================================================
--  0068 — ConnectEstate AI: verktyget summarize_records (summa, medel,
--  min/max över alla poster som matchar, t.ex. antal portar). Räknas i
--  ai-chat utan att posterna skickas till AI:n.
-- =====================================================================

update ai_agents
   set system_prompt = replace(system_prompt, E'- Använd filter i stället',
         E'- Summor, medelvärden, min/max (t.ex. antal portar): summarize_records, med groupBy för uppdelning. Räkna aldrig ihop själv.\n- Använd filter i stället')
 where key = 'crm_ai' and system_prompt not like '%summarize_records%';

update ai_agents
   set allowed_tools = array_append(allowed_tools, 'summarize_records')
 where not ('summarize_records' = any(allowed_tools)) and 'search_records' = any(allowed_tools);
