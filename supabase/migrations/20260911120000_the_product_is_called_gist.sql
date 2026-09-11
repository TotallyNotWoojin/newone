-- The app is renamed from Newone to Gist. Two of the strings a user actually
-- reads are stored server-side rather than in the client catalog:
--
--   1. the personal realm's organization name, which the desktop chat list
--      prints above the filters, and
--   2. the push fallback sender name, used when a profile carries no display
--      name.
--
-- Everything else keeping the old spelling -- the edge function names, the
-- X-Newone-* request headers, column names like
-- external_verification_performed_by_newone -- is invisible plumbing and is
-- deliberately left alone.

-- 1. The organization row. Named by the signup path, so new accounts already
--    get whatever this row says; this fixes the realm that exists.
update public.organizations
   set name = 'Gist'
 where id = private.personal_realm_organization_id()
   and name = 'Newone';

-- 2. The push resolver's fallback literal. The resolver has been rewritten
--    several times, most recently to repair the consumer recipient list, so
--    the definition in any one migration file is not necessarily what is
--    deployed. Read the live definition, change only the literal, and refuse
--    to run if the shape is not what we expect -- a bulk SQL rewrite that
--    assumed the file was current is exactly what took push down before.
do $$
declare
  v_function record;
  v_definition text;
  v_updated text;
  v_shrink integer;
  v_count integer := 0;
begin
  for v_function in
    select p.oid, n.nspname, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('private', 'public')
       and p.prokind = 'f'
       and p.prosrc like '%''Newone''%'
  loop
    v_definition := pg_get_functiondef(v_function.oid);
    v_updated := replace(v_definition, '''Newone''', '''Gist''');

    -- Only the quoted literal may move, and each occurrence must shorten the
    -- text by exactly two characters. Anything else means replace() caught
    -- something this migration did not intend to touch.
    v_shrink := length(v_definition) - length(v_updated);
    if v_shrink = 0 or v_shrink % 2 <> 0 then
      raise exception 'unexpected replacement in %.%: text shrank by %',
        v_function.nspname, v_function.proname, v_shrink;
    end if;

    execute v_updated;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'no function carried the Newone fallback literal; expected at least the push resolver';
  end if;

  raise notice 'rebranded % function(s)', v_count;
end $$;

-- Proof, not hope: nothing in either schema may still answer with the old name.
do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('private', 'public') and p.prosrc like '%''Newone''%';
  if v_left > 0 then
    raise exception '% function(s) still carry the old product name', v_left;
  end if;

  select count(*) into v_left from public.organizations where name = 'Newone';
  if v_left > 0 then
    raise exception '% organization row(s) still named Newone', v_left;
  end if;
end $$;
