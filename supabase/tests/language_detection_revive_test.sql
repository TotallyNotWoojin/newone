begin;
select plan(3);

select has_function('private', 'revive_stuck_language_detection_internal', 'revive function exists');
select is(
  (select count(*)::int from cron.job where jobname = 'newone-language-detection-revive'),
  1,
  'revive cron job is scheduled'
);
-- A message stuck pending for over two minutes without a job gets exactly one job.
insert into public.messages (organization_id, conversation_id, client_nonce, kind, body, language_code, created_at, available_at, sender_user_id, language_detection_state)
select c.organization_id, c.id, gen_random_uuid(), 'text', 'stuck pending body', 'en', now() - interval '5 minutes', now() - interval '5 minutes', m.user_id, 'pending'
from public.conversations c join public.conversation_members m on m.conversation_id = c.id
where c.organization_id = '11111111-1111-4111-8111-111111111111' limit 1;
select is(
  (select private.revive_stuck_language_detection_internal()) >= 1,
  true,
  'revive enqueues detection for the stuck message'
);

select * from finish();
rollback;
