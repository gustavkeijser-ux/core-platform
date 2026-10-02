-- _koppla_leveranser räknade om norm_bolag() för alla kundkort i varje
-- jämförelse (CTE:erna inlinades). Med Avslutade inlästa blev det för långsamt
-- (statement timeout). Materialisera CTE:erna så att normaliseringen görs en gång.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public._koppla_leveranser(uuid)'::regprocedure);
  if position('km as materialized' in d) > 0 then return; end if;
  if position('  with lev as (' in d) = 0 or position('  km as (' in d) = 0 then
    raise exception '_koppla_leveranser: hittar inte insättningspunkten';
  end if;
  d := replace(d, '  with lev as (', '  with lev as materialized (');
  d := replace(d, '  km as (', '  km as materialized (');
  execute d;
end $mig$;
