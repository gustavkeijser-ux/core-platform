-- Datetime-fält sparades som "2026-09-25T14:28:00+00". Offset utan minuter
-- ("+00") är inte giltig ISO 8601 för JavaScripts Date — Safari och Chrome
-- ger "Invalid Date". Spara i stället alltid i UTC med "Z":
-- "2026-09-25T14:28:00Z".

do $$
declare d text;
begin
  d := pg_get_functiondef('public.validate_record_data'::regproc);
  d := replace(d,
    $x$to_char((v_raw #>> '{}')::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SSOF')$x$,
    $x$to_char((v_raw #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')$x$);
  if position('HH24:MI:SS"Z"' in d) = 0 then
    raise exception 'validate_record_data: datetime-formatet hittades inte';
  end if;
  execute d;
end $$;

-- Befintliga värden: skriv om alla datetime-fält till samma UTC-format.
update records r
   set data = r.data || jsonb_build_object(fd.key,
         to_char((r.data->>fd.key)::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  from field_definitions fd
  join object_definitions od on od.id = fd.object_id
 where fd.field_type = 'datetime'
   and od.key = r.object_type and od.tenant_id = r.tenant_id
   and coalesce(r.data->>fd.key, '') <> ''
   and r.data->>fd.key !~ 'Z$';
