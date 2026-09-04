begin;
select plan(2);
select has_function('private', 'queue_message_language_pipeline_internal', 'language pipeline helper exists');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'bff_forward_message_impl'
     and pg_get_functiondef(p.oid) like '%queue_message_language_pipeline_internal%'),
  1,
  'forward path queues detection and translations for the forwarded copy'
);
select * from finish();
rollback;
