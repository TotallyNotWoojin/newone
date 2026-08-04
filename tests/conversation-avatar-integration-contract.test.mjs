import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('conversation avatars use a scanned upload, authoritative activation, and CAS removal', async () => {
  const [routes, repository, workspace] = await Promise.all([
    load('../supabase/functions/newone-api/routes.ts'),
    load('../apps/newone/src/data/repositories/bff-command-repository.ts'),
    load('../apps/newone/src/state/workspace.tsx'),
  ]);
  assert.match(routes, /bff_create_conversation_avatar_upload/);
  assert.match(routes, /CONVERSATION_AVATAR_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(routes, /CONVERSATION_AVATAR_MIME_TYPES = new Set/);
  assert.match(routes, /bff_activate_conversation_avatar/);
  assert.match(routes, /p_expected_avatar_path: values\.expectedAvatarPath/);
  assert.match(routes, /bff_remove_conversation_avatar/);
  assert.match(repository, /createConversationAvatarUploadGrant/);
  assert.match(repository, /activateConversationAvatar/);
  assert.match(repository, /removeConversationAvatar/);
  assert.match(workspace, /await completion\(\);[\s\S]{0,300}attachmentObjectNotReady/);
  assert.match(workspace, /getAttachmentState[\s\S]{0,900}scanStatus === 'clean'/);
  assert.match(workspace, /scanStatus === 'blocked' \|\| state\.scanStatus === 'failed'/);
  assert.match(workspace, /expectedAvatarPath: conversation\.avatarPath \?\? null/);
});

test('avatar reads accept only an attachment identity and return a two-minute in-memory grant', async () => {
  const [routes, repository, workspace] = await Promise.all([
    load('../supabase/functions/newone-api/routes.ts'),
    load('../apps/newone/src/data/repositories/bff-command-repository.ts'),
    load('../apps/newone/src/state/workspace.tsx'),
  ]);
  assert.match(routes, /onlyKeys\(body, \['organizationId', 'attachmentId'\]\)/);
  assert.match(routes, /bff_authorize_conversation_avatar_download/);
  assert.match(routes, /createSignedUrl\(metadata\.storagePath, 120\)/);
  assert.match(routes, /attachmentId: values\.attachmentId,[\s\S]{0,120}expiresInSeconds: 120/);
  assert.doesNotMatch(repository, /avatar\/query[\s\S]{0,180}storagePath/);
  assert.match(workspace, /conversationAvatarCacheRef = useRef\(new Map/);
  assert.match(workspace, /conversationAvatarTimersRef = useRef\(new Map/);
  assert.match(workspace, /getConversationAvatarReadGrant/);
  assert.doesNotMatch(workspace, /AsyncStorage[\s\S]{0,200}conversationAvatar/);
});

test('group photo controls provide retry recovery and localized avatar lifecycle events', async () => {
  const [screen, pane, reader, catalog] = await Promise.all([
    load('../apps/newone/src/app/new-group.tsx'),
    load('../apps/newone/src/features/chat/conversation-pane.tsx'),
    load('../apps/newone/src/data/repositories/web-read-repository.ts'),
    load('../apps/newone/src/i18n/catalog.ts'),
  ]);
  assert.match(screen, /launchImageLibraryAsync\(\{[\s\S]{0,180}allowsEditing: true,[\s\S]{0,80}aspect: \[1, 1\]/);
  assert.match(screen, /createdConversationId/);
  assert.match(screen, /retryAvatarUpload/);
  assert.match(screen, /continueWithoutAvatar/);
  assert.match(pane, /uploadConversationAvatar/);
  assert.match(pane, /removeConversationAvatar/);
  assert.match(reader, /conversation\.avatar\.changed/);
  assert.match(reader, /conversation\.avatar\.removed/);
  for (const key of [
    'group.avatarTitle',
    'group.avatarUploadFailed',
    'group.retryAvatarUpload',
    'group.continueWithoutAvatar',
    'chat.systemAvatarChanged',
    'chat.systemAvatarRemoved',
  ]) assert.equal((catalog.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g')) ?? []).length, 3);
});
