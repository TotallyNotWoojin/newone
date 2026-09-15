// Real-API proof for the conversation summary (v3.1, reader-defined scope):
// two real signups, a message request accepted, a short thread, then the
// requester asks for a summary of "today" about a subject through the route
// the app uses. A second, long thread (about 20,000 characters) is summarized
// as "everything", which the AI worker must cut into slices and merge.
// Expected: 202s, rows that reach draft with the scope columns filled, a
// "summary_range_empty" refusal for a range with nothing in it, provenance
// slices > 1 for the long run, and the timing of each.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayDownload, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });
const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hi Eli, can we move the print run to Monday morning?' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `sum-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sent = 0;
const send = async (user, body) => {
  sent += 1;
  const r = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
    installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `sum-${runId}-m${sent}`,
    body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body },
  });
  if (r.status !== 201) fail(`message ${sent} failed (${r.status})`, r.payload);
  const d = r.payload?.data ?? r.payload;
  return String(d?.messageId ?? d?.id ?? '');
};
await send(eli, 'Monday morning works. The paper arrives Friday so we can start at 8.');
await send(ana, 'Great. Please bring the two proof copies and the invoice for the client.');
await send(eli, 'Will do. I will also ask the courier to pick up at noon.');
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const utcOffsetMinutes = -new Date().getTimezoneOffset();
const requestSummary = async (label, range, expectedStatus = 202) => {
  const response = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/summaries`, keys, {
    installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-${label}`,
    body: { organizationId: PERSONAL_REALM_ID, languageCode: 'en', range: { utcOffsetMinutes, ...range } },
  });
  console.log(`summary request (${label}) →`, response.status, JSON.stringify(response.payload?.data ?? response.payload).slice(0, 300));
  if (response.status !== expectedStatus) fail(`summary request ${label} returned ${response.status}, expected ${expectedStatus}`, response.payload);
  return response.payload?.data ?? response.payload;
};
const summariesOf = () => rows(`select id, status, request_mode, failure_code, scope_kind, scope_subject,
    cardinality(source_message_ids) as source_count, processor_provenance->>'slices' as slices,
    primary_topic, left(summary_body, 240) as summary_body, decisions, action_items, created_at, updated_at
  from public.conversation_summaries where conversation_id = '${conversationId}' order by created_at desc`);
const waitForTerminal = async (summaryId, requestedAt) => {
  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const row = (await summariesOf()).find((entry) => entry.id === summaryId);
    if (row && !['queued', 'pending', 'generating', 'processing', 'requested'].includes(String(row.status))) { final = row; break; }
  }
  const seconds = Math.round((Date.now() - requestedAt) / 1000);
  console.log(`after ${seconds}s:`, JSON.stringify(final, null, 1));
  if (!final) fail(`summary ${summaryId} did not reach a terminal state within 180s`, await summariesOf());
  if (final.status !== 'draft' && final.status !== 'approved') {
    fail(`summary ended in ${final.status} (${final.failure_code ?? 'no failure code'})`, final);
  }
  const text = `${final.primary_topic ?? ''} ${final.summary_body ?? ''}`;
  if (/\bs[0-9]{4}\b/.test(text) || /participant [0-9]/i.test(text)) fail('summary text carries source ids or participant labels', final);
  return { final, seconds };
};

// 1. Today, about a subject: the four text messages so far.
const shortRequestedAt = Date.now();
const short = await requestSummary('today', { kind: 'today', subject: 'the print run' });
if (short.scopeKind !== 'today' || short.scopeSubject !== 'the print run' || short.sourceMessageCount !== 4) {
  fail('summary receipt did not echo the reader\'s scope', short);
}
const shortResult = await waitForTerminal(short.summaryId, shortRequestedAt);
if (shortResult.final.scope_kind !== 'today' || shortResult.final.scope_subject !== 'the print run' || Number(shortResult.final.source_count) !== 4) {
  fail('summary row did not keep the reader\'s scope', shortResult.final);
}
// A subject narrows the recap but keeps its shape: numbered, name-first lines
// (the phone showed a paragraph for "about the plan", Sep 15 2026).
const shortLines = String(shortResult.final.summary_body ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
if (!/^1[.)]\s+(Ana|Eli|Smoke)\b/.test(shortLines[0] ?? '')) fail('a recap about a subject should still be numbered, name-first lines', shortResult.final);
console.log(`PASS (today · about the print run): ${shortResult.final.status} in ≤${shortResult.seconds}s — topic: ${shortResult.final.primary_topic ?? '(none)'}`);

// 2. A range with nothing in it is refused by name, never queued.
const empty = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/summaries`, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-yesterday`,
  body: { organizationId: PERSONAL_REALM_ID, languageCode: 'en', range: { kind: 'yesterday', utcOffsetMinutes } },
});
console.log('summary request (yesterday) →', empty.status, JSON.stringify(empty.payload).slice(0, 200));
if (empty.status !== 422 || !JSON.stringify(empty.payload).includes('summary_range_empty')) {
  fail('an empty range should answer 422 summary_range_empty', empty.payload);
}

// 3. A long thread (12 messages of ~1,700 characters ≈ 20,400 characters,
//    over the 18,000-character slice limit) summarized as "everything".
const topics = ['the paper stock', 'the courier pickup', 'the proof copies', 'the invoice', 'the press schedule', 'the client meeting'];
const longBody = (index) => {
  const topic = topics[index % topics.length];
  const sentences = [];
  for (let n = 1; sentences.join(' ').length < 1650; n += 1) {
    sentences.push(`Update ${index + 1}.${n} on ${topic}: we agreed to keep the plan as discussed and to confirm the details with the team before Monday.`);
  }
  return sentences.join(' ');
};
for (let index = 0; index < 12; index += 1) {
  await send(index % 2 === 0 ? eli : ana, longBody(index));
  await sleep(150);
}
const longRequestedAt = Date.now();
const long = await requestSummary('everything', { kind: 'everything', subject: null });
if (long.scopeKind !== 'everything' || long.sourceMessageCount !== 16) fail('long-range receipt did not cover every text message', long);
const longResult = await waitForTerminal(long.summaryId, longRequestedAt);
if (Number(longResult.final.slices) < 2 || Number(longResult.final.source_count) !== 16) {
  fail('the long range should have been summarized in slices', longResult.final);
}
const jobs = await rows(`select id, topic, status, attempts, last_error_code, created_at, completed_at from private.outbox_jobs
  where topic = 'summary' and organization_id = '${PERSONAL_REALM_ID}' and created_at > now() - interval '15 minutes' order by id desc limit 5`);
console.log('summary jobs:', JSON.stringify(jobs));
console.log(`PASS (everything, ${longResult.final.slices} slices, ${longResult.final.source_count} messages): ${longResult.final.status} in ≤${longResult.seconds}s — topic: ${longResult.final.primary_topic ?? '(none)'}`);

// 4. The longer spans the owner's father asked for (Sep 14 2026): "last 30
//    days" is accepted, kept on the row, and the recap comes back in the
//    shape he described: at most ten short numbered lines that open with a
//    name, no decisions or to-do lists, never a paragraph, never "you".
const monthRequestedAt = Date.now();
const month = await requestSummary('last_30_days', { kind: 'last_30_days', subject: null });
if (month.scopeKind !== 'last_30_days') fail('30-day receipt did not echo the range', month);
const monthResult = await waitForTerminal(month.summaryId, monthRequestedAt);
if (monthResult.final.scope_kind !== 'last_30_days') fail('30-day row did not keep the range', monthResult.final);
const monthLines = String(monthResult.final.summary_body ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
console.log('30-day recap lines:', JSON.stringify(monthLines));
if (monthLines.length < 2 || !/^1[.)]\s/.test(monthLines[0] ?? '')) fail('the recap should be numbered lines, one per line', monthResult.final);
if (monthLines.length > 10) fail(`the recap should be at most ten lines, got ${monthLines.length}`, monthResult.final);
// The smoke accounts are named "Smoke ana" and "Smoke eli", so their first name is Smoke.
if (!/^\d+[.)]\s+(Ana|Eli|Smoke)\b/.test(monthLines[0] ?? '')) fail('each recap line should open with the speaker\'s name', monthResult.final);
const longest = Math.max(...monthLines.map((line) => line.replace(/^\d+[.)]\s+/, '').split(/\s+/).length));
if (longest > 28) fail(`recap lines should be short phrases; the longest has ${longest} words`, monthResult.final);
if ((monthResult.final.decisions ?? []).length || (monthResult.final.action_items ?? []).length) {
  fail('a final recap carries no decisions or to-do lists any more', monthResult.final);
}
console.log(`PASS (last 30 days, ${monthLines.length} short name-first lines, no lists): ${monthResult.final.status} in ≤${monthResult.seconds}s`);

// 5. The recap as a file, the way the owner's father wanted to download it
//    (Sep 14 2026): a real PDF by default and a real Word document on request,
//    rendered by the service; only the requester can take it out.
const exportPath = `/v2/conversations/${conversationId}/summaries/${month.summaryId}/export`;
const pdf = await gatewayDownload('newone-read', exportPath, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, accept: 'application/pdf',
  body: { organizationId: PERSONAL_REALM_ID, format: 'pdf', timeZone: 'America/Los_Angeles', locale: 'en' },
});
if (pdf.status !== 200) fail(`PDF export returned ${pdf.status}`, pdf.text().slice(0, 300));
if (!pdf.contentType?.startsWith('application/pdf')) fail('PDF export has the wrong media type', pdf.contentType);
if (new TextDecoder().decode(pdf.bytes.slice(0, 5)) !== '%PDF-') fail('PDF export does not start like a PDF', pdf.bytes.slice(0, 16));
if (!/attachment; filename="Gist summary - .*\.pdf"/.test(pdf.disposition ?? '')) fail('PDF export is not an attachment', pdf.disposition);
if (pdf.bytes.byteLength < 2_000) fail('PDF export is suspiciously small', pdf.bytes.byteLength);
// NEWONE_SMOKE_OUT=<dir> keeps the files so a person can open them.
if (process.env.NEWONE_SMOKE_OUT) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(process.env.NEWONE_SMOKE_OUT, { recursive: true });
  writeFileSync(`${process.env.NEWONE_SMOKE_OUT}/smoke-summary.pdf`, pdf.bytes);
}
const docx = await gatewayDownload('newone-read', exportPath, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken,
  body: { organizationId: PERSONAL_REALM_ID, format: 'docx', timeZone: 'America/Los_Angeles', locale: 'en' },
});
if (docx.status !== 200) fail(`Word export returned ${docx.status}`, docx.text().slice(0, 300));
if (docx.bytes[0] !== 0x50 || docx.bytes[1] !== 0x4b) fail('Word export is not a docx package', docx.bytes.slice(0, 8));
if (!docx.contentType?.includes('wordprocessingml')) fail('Word export has the wrong media type', docx.contentType);
if (process.env.NEWONE_SMOKE_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${process.env.NEWONE_SMOKE_OUT}/smoke-summary.docx`, docx.bytes);
}
const foreign = await gatewayDownload('newone-read', exportPath, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken,
  body: { organizationId: PERSONAL_REALM_ID, format: 'pdf' },
});
if (foreign.status !== 404) fail(`another member could export the requester's recap (${foreign.status})`, foreign.text().slice(0, 200));
console.log(`PASS (export: PDF ${pdf.bytes.byteLength} bytes, Word ${docx.bytes.byteLength} bytes, other member refused with 404)`);
