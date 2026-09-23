// Real-API proof for projects inside a chat (owner's father, Sep 23 2026):
// three real signups (Korean, Spanish, English) in one group, nothing seeded
// into the database. Kyle makes two projects and files into one; what he
// sends while it is selected (a link, a PDF, a photo) lands in its drawers by
// itself, and a summary he asks for is saved there and named by the AI. Luis
// sees all of it, takes the summary out as a PDF, finds the chat by a word
// and by the project's name, and files his own earlier link by hand. Ana,
// outside the chat, reaches none of it. Before any of that, a chat with one
// short message is refused a summary until there is enough conversation.
//
//   node tests/hosted/projects-smoke.mjs
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  PROJECT_URL,
  fail,
  gatewayDownload,
  gatewayPost,
  loadAccessToken,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const runId = makeRunId();
const keys = projectKeys(loadAccessToken());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dataOf = (response) => response.payload?.data ?? response.payload;
let step = 0;
const pass = (label, detail = '') => console.log(`ok  ${label}${detail ? ` - ${detail}` : ''}`);

function call(fn, user, path, body, idempotent = true) {
  step += 1;
  return gatewayPost(fn, path, keys, {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: idempotent ? `projects-${runId}-${step}` : undefined,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  });
}
function expectStatus(response, status, what) {
  if (response.status !== status) fail(`${what} answered ${response.status}, expected ${status}`, response.payload);
  return dataOf(response);
}
function expect(condition, what, detail) {
  if (!condition) fail(what, detail);
}

const kyle = await signupUser(keys, { runId, label: 'kyle', language: 'ko' });
const luis = await signupUser(keys, { runId, label: 'luis', language: 'es' });
const marisol = await signupUser(keys, { runId, label: 'marisol', language: 'es' });
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
pass('four_signups', `${kyle.username}, ${luis.username}, ${marisol.username}, ${ana.username}`);

async function connect(from, to, body) {
  const request = expectStatus(
    await call('newone-api', from, '/v2/contacts/message-requests', { targetUserId: to.userId, body }),
    201,
    'message request',
  );
  expectStatus(
    await call('newone-api', to, `/v2/contacts/connections/${from.userId}/respond`, { decision: 'accepted' }),
    200,
    'accepting',
  );
  return String(request.conversationId);
}
await connect(kyle, luis, '안녕하세요 Luis');
await connect(kyle, marisol, '안녕하세요 Marisol');
const group = expectStatus(
  await call('newone-api', kyle, '/v2/conversations/group', {
    name: `Administration ${runId.slice(-6)}`,
    kind: 'group',
    memberAssignments: [
      { membershipId: luis.userId, role: 'member' },
      { membershipId: marisol.userId, role: 'member' },
    ],
  }),
  201,
  'group creation',
);
const chat = String(group.conversationId);
pass('group_created', chat);

async function send(user, body) {
  const sent = expectStatus(
    await call('newone-api', user, `/v2/conversations/${chat}/messages`, {
      clientMessageId: randomUUID(),
      kind: 'text',
      body,
    }),
    201,
    `sending "${body.slice(0, 30)}"`,
  );
  return String(sent.messageId ?? sent.id);
}

async function sendFile(user, { fileName, mimeType, bytes }) {
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const message = expectStatus(
    await call('newone-api', user, `/v2/conversations/${chat}/messages`, {
      clientMessageId: randomUUID(),
      kind: 'attachment',
      body: null,
    }),
    201,
    `${fileName} message`,
  );
  const grant = expectStatus(
    await call('newone-api', user, '/v2/attachments/grants', {
      action: 'upload',
      conversationId: chat,
      messageId: String(message.messageId),
      fileName,
      mimeType,
      byteSize: bytes.length,
      sha256Hex,
    }),
    201,
    `${fileName} grant`,
  ).grant;
  const target = grant.signedUrl.startsWith('http') ? grant.signedUrl : `${PROJECT_URL}/storage/v1${grant.signedUrl}`;
  const upload = await fetch(target, {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'x-upsert': 'false' },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  expect(upload.ok, `${fileName} upload failed (${upload.status})`, await upload.text());
  expectStatus(
    await call('newone-api', user, `/v2/attachments/${grant.attachmentId}/complete`, {
      bucket: grant.bucket,
      path: grant.path,
      byteSize: bytes.length,
      sha256Hex,
    }),
    202,
    `${fileName} completion`,
  );
  return grant.attachmentId;
}

const command = (user, body) => call('newone-api', user, `/v2/conversations/${chat}/projects/commands`, body);
const projectsOf = async (user) =>
  expectStatus(await call('newone-read', user, `/v2/conversations/${chat}/projects/query`, {}, false), 200, 'projects read');
const readiness = async (user) =>
  expectStatus(
    await call('newone-read', user, `/v2/conversations/${chat}/summaries/readiness`, { utcOffsetMinutes: 0 }, false),
    200,
    'summary readiness',
  );
const find = async (user, query) =>
  expectStatus(await call('newone-read', user, '/v2/find/query', { query }, false), 200, `find "${query}"`).results;

// 1. Too little to summarize: the readiness read and the request agree. (A
// chat with no text at all is "summary_range_empty", as before.)
await send(kyle, '테스트');
const thin = await readiness(kyle);
expect(
  thin.ranges?.everything?.ready === false && thin.minimumMessages === 3 && thin.minimumCharacters === 200,
  'a fresh chat should not be ready for a summary',
  thin,
);
const refused = await call('newone-api', kyle, `/v2/conversations/${chat}/summaries`, {
  languageCode: 'ko',
  range: { kind: 'everything', utcOffsetMinutes: 0 },
});
expect(
  refused.status === 422 && refused.payload?.error?.code === 'summary_not_enough_conversation',
  'a thin chat must be refused with summary_not_enough_conversation',
  refused,
);
pass('thin_chat_refused_a_summary', `${thin.ranges.everything.messages} messages, ${thin.ranges.everything.characters} characters`);

// 2. Two projects; the creator's selection follows the newest, and a
// duplicate name is refused.
const hdg = expectStatus(await command(kyle, { action: 'create', name: ' HDG ' }), 200, 'create HDG');
const maintenance = expectStatus(await command(kyle, { action: 'create', name: 'Maintenance' }), 200, 'create Maintenance');
expect(maintenance.selectedProjectId === maintenance.projectId, 'the creator files into the project just made', maintenance);
expectStatus(await command(luis, { action: 'create', name: 'hdg' }), 409, 'a duplicate project name');
const selected = expectStatus(await command(kyle, { action: 'select', projectId: hdg.projectId }), 200, 'select HDG');
expect(selected.selectedProjectId === hdg.projectId, 'HDG is now selected', selected);
pass('projects_created_and_selected', `${hdg.projectId}, ${maintenance.projectId}`);

// 3. What Kyle sends while HDG is selected files itself. Luis, with no
// project selected, files nothing.
const luisLink = await send(luis, 'El plano está en https://drive.example.com/plano-hdg.');
await send(kyle, '사이트는 www.newoneinc.com 입니다. 계약서 올립니다.');
const pdfId = await sendFile(kyle, {
  fileName: 'HT contract.pdf',
  mimeType: 'application/pdf',
  bytes: readFileSync(join(HERE, '../device/fixtures/newone-sample.pdf')),
});
const photoId = await sendFile(kyle, {
  fileName: 'panel.jpg',
  mimeType: 'image/jpeg',
  bytes: readFileSync(join(HERE, '../e2e/fixtures/copy-me.jpg')),
});
await send(kyle, '나무 사이즈는 괜찮은데 나무 겉에 한번 포장했으면 좋겠습니다. 우드판넬 상단이 반듯하게 일직선으로 잘렸는지 확인 부탁드립니다.');
await send(luis, 'No, esta madera solo se puso para dimensionar la superficie; se va a cortar y detallar los bordes para que quede presentable. La idea es pintar toda la base de blanco.');
await send(marisol, 'Perfecto. Mañana llega el ácido a Otay y Francisco confirma cuando esté en el almacén.');
await send(kyle, '원본 ppt 파일 이메일로 부탁합니다. 산 성분 자재는 금요일에 도착 예정입니다.');

let drawers = await projectsOf(kyle);
const inHdg = (kind) => drawers.items.filter((item) => item.projectId === hdg.projectId && item.kind === kind);
expect(inHdg('link').map((item) => item.url).includes('https://www.newoneinc.com/'), 'the link Kyle sent is in HDG', drawers.items);
expect(
  inHdg('upload').map((item) => item.attachmentId).sort().join() === [pdfId, photoId].sort().join(),
  'the PDF and the photo Kyle sent are in HDG',
  drawers.items,
);
expect(!drawers.items.some((item) => item.url === 'https://drive.example.com/plano-hdg'), 'Luis filed nothing', drawers.items);
const photo = inHdg('upload').find((item) => item.attachmentId === photoId);
expect(typeof photo?.previewUrl === 'string' && photo.previewUrl.startsWith('https://') && !('storagePath' in photo), 'the photo carries a signed preview and no storage path', photo);
pass('sent_items_filed_themselves', `${inHdg('link').length} link, ${inHdg('upload').length} uploads`);

// 4. Enough now: the summary Kyle asks for is saved into HDG and named.
const ready = await readiness(kyle);
expect(ready.ranges.everything.ready === true, 'the chat is now ready for a summary', ready.ranges.everything);
const requested = expectStatus(
  await call('newone-api', kyle, `/v2/conversations/${chat}/summaries`, {
    languageCode: 'ko',
    range: { kind: 'everything', utcOffsetMinutes: 0 },
  }),
  202,
  'summary request',
);
const summaryId = requested.summaryId;
const startedAt = Date.now();
let summaryItem = null;
for (let attempt = 0; attempt < 90; attempt += 1) {
  drawers = await projectsOf(kyle);
  summaryItem = drawers.items.find((item) => item.summaryId === summaryId);
  if (summaryItem?.summaryState === 'ready') break;
  await sleep(2000);
}
expect(summaryItem?.projectId === hdg.projectId, 'the summary was saved into HDG', drawers.items);
expect(summaryItem?.summaryState === 'ready', 'the summary finished within three minutes', summaryItem);
expect(/ #1$/.test(summaryItem.title ?? ''), 'the saved summary is named by the AI and numbered', summaryItem);
pass('summary_saved_and_named', `"${summaryItem.title}" in ${Math.round((Date.now() - startedAt) / 1000)}s`);

// 5. Everyone in the chat sees the projects, and a saved summary exports
// for them too.
const seenByLuis = await projectsOf(luis);
expect(seenByLuis.projects.map((project) => project.name).join() === 'HDG,Maintenance', 'Luis sees both projects', seenByLuis.projects);
expect(seenByLuis.selectedProjectId === null, 'Luis has no project selected', seenByLuis);
expect(seenByLuis.items.some((item) => item.summaryId === summaryId), 'Luis sees the saved summary', seenByLuis.items);
const exportPath = `/v2/conversations/${chat}/summaries/${summaryId}/export`;
const pdf = await gatewayDownload('newone-read', exportPath, keys, {
  installationId: luis.installationId,
  accessToken: luis.accessToken,
  accept: 'application/pdf',
  body: { organizationId: PERSONAL_REALM_ID, format: 'pdf', timeZone: 'America/Tijuana', locale: 'es' },
});
expect(pdf.status === 200 && new TextDecoder().decode(pdf.bytes.slice(0, 5)) === '%PDF-', 'Luis takes the saved summary out as a PDF', { status: pdf.status, text: pdf.text().slice(0, 200) });
pass('members_see_projects_and_export', `${pdf.bytes.length} byte PDF for Luis`);

// 6. The file can be renamed; the date is never part of what is stored.
const renamed = expectStatus(
  await command(kyle, { action: 'rename_item', itemId: summaryItem.itemId, name: 'Acid summary for Luis' }),
  200,
  'rename the summary file',
);
expect(renamed.itemId === summaryItem.itemId, 'rename answers with the item', renamed);
const afterRename = (await projectsOf(luis)).items.find((item) => item.itemId === summaryItem.itemId);
expect(afterRename?.title === 'Acid summary for Luis', 'Luis sees the new name', afterRename);
pass('summary_file_renamed');

// 7. Luis files his own earlier link into Maintenance by hand.
const filed = expectStatus(
  await command(luis, {
    action: 'add_item',
    projectId: maintenance.projectId,
    target: { kind: 'link', messageId: luisLink, url: 'https://drive.example.com/plano-hdg' },
  }),
  200,
  'file a link by hand',
);
expect(typeof filed.itemId === 'string', 'the hand-filed link has an item', filed);
expectStatus(
  await command(luis, {
    action: 'add_item',
    projectId: maintenance.projectId,
    target: { kind: 'link', messageId: luisLink, url: 'https://evil.example.com/' },
  }),
  404,
  'a link the message does not carry',
);
pass('link_filed_by_hand');

// 8. 찾기: a word, the start of a longer Korean word, and a project's name
// each name the chat; nobody outside the chat finds anything.
const byWord = await find(luis, 'Otay');
expect(byWord.some((result) => result.conversationId === chat && result.messageCount >= 1), 'a word finds the chat', byWord);
const byPrefix = await find(kyle, '우드판');
expect(byPrefix.some((result) => result.conversationId === chat), 'the start of a Korean word finds the chat', byPrefix);
const byProject = await find(luis, 'hdg');
const projectHit = byProject.find((result) => result.conversationId === chat);
expect(projectHit?.projects?.some((project) => project.name === 'HDG'), 'a project name finds the chat', byProject);
const outsider = await find(ana, 'Otay');
expect(outsider.length === 0, 'someone outside the chat finds nothing', outsider);
expectStatus(await call('newone-read', ana, `/v2/conversations/${chat}/projects/query`, {}, false), 403, 'projects read from outside the chat');
expectStatus(await command(ana, { action: 'create', name: 'Intruder' }), 403, 'project creation from outside the chat');
pass('find_by_keyword', `${byWord[0]?.messageCount} message(s) for "Otay"`);

// 9. Deleting a project empties its drawers and nobody's files.
expectStatus(await command(kyle, { action: 'delete', projectId: maintenance.projectId }), 200, 'delete Maintenance');
const afterDelete = await projectsOf(luis);
expect(afterDelete.projects.length === 1 && !afterDelete.items.some((item) => item.projectId === maintenance.projectId), 'Maintenance and its drawer are gone', afterDelete);
const stillThere = await call('newone-api', luis, '/v2/attachments/grants', { action: 'download', conversationId: chat, attachmentId: pdfId });
expect(stillThere.status === 200, 'the PDF itself is still in the chat', stillThere);
pass('project_deleted_files_kept');

console.log(`PASS: projects smoke (${runId})`);
