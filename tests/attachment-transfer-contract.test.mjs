import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nativeTransfer = readFileSync('apps/newone/src/data/attachment-upload.native.ts', 'utf8');
const webTransfer = readFileSync('apps/newone/src/data/attachment-upload.web.ts', 'utf8');
const attachments = readFileSync('apps/newone/src/data/attachments.ts', 'utf8');
const nativeCleanup = readFileSync('apps/newone/src/data/attachment-cleanup.native.ts', 'utf8');
const webCleanup = readFileSync('apps/newone/src/data/attachment-cleanup.web.ts', 'utf8');
const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');

test('native attachments use a foreground cancellable binary task with progress', () => {
  assert.match(nativeTransfer, /createUploadTask/);
  assert.match(nativeTransfer, /httpMethod: 'PUT'/);
  assert.match(nativeTransfer, /UploadType\.BINARY_CONTENT/);
  assert.match(nativeTransfer, /sessionType: 'foreground'/);
  assert.match(nativeTransfer, /signal: options\.signal/);
  assert.match(nativeTransfer, /onProgress/);
  assert.match(nativeTransfer, /task\.release\(\)/);
});

test('web attachments expose progress and abort without cross-origin credentials', () => {
  assert.match(webTransfer, /new XMLHttpRequest\(\)/);
  assert.match(webTransfer, /request\.open\('PUT', signedUrl, true\)/);
  assert.match(webTransfer, /request\.withCredentials = false/);
  assert.match(webTransfer, /request\.upload\.onprogress/);
  assert.match(webTransfer, /addEventListener\('abort'/);
  assert.match(webTransfer, /request\.abort\(\)/);
});

test('shared upload maps cancellation separately and never removes scanner completion', () => {
  assert.match(attachments, /error\.name === 'AbortError'/);
  assert.match(attachments, /upload_cancelled/);
  assert.match(attachments, /transferAttachment/);
  assert.doesNotMatch(attachments, /fetch\(grant\.signedUrl/);
});

test('optimized temporary attachments have bounded platform cleanup', () => {
  assert.match(attachments, /temporary: true/);
  assert.match(attachments, /cleanupPreparedAttachment/);
  assert.match(nativeCleanup, /new File\(uri\)/);
  assert.match(nativeCleanup, /file\.delete\(\)/);
  assert.match(webCleanup, /URL\.revokeObjectURL\(uri\)/);
});

test('workspace keeps failed placeholders and exposes progress, cancel, retry, and scan reconciliation', () => {
  assert.match(workspace, /grantIdempotencyKey: createClientId\(\)/);
  assert.match(workspace, /idempotencyKey: operation\.grantIdempotencyKey/);
  assert.match(workspace, /onProgress: \(progress\)/);
  assert.match(workspace, /operation\.controller\.abort\(\)/);
  assert.match(workspace, /retryAttachmentUpload/);
  assert.match(workspace, /state: 'failed'/);
  assert.match(workspace, /watchAttachmentScan/);
  assert.doesNotMatch(workspace, /Never strand an\s+invisible blank message/);
});

test('attachment cards expose accessible progress, cancel, retry, and cancelled cleanup controls', () => {
  assert.match(pane, /accessibilityRole="progressbar"/);
  assert.match(pane, /accessibilityValue=\{\{ min: 0, max: 100, now: progressPercent/);
  assert.match(pane, /workspace\.cancelAttachmentUpload\(message\)/);
  assert.match(pane, /workspace\.retryAttachmentUpload\(message\)/);
  assert.match(pane, /transfer\?\.state === 'failed'/);
  assert.match(pane, /transfer\?\.state === 'cancelled'/);
  assert.match(pane, /chat\.attachmentFinishCleanup/);
  assert.match(catalog, /'chat\.attachmentCancel': 'Cancel upload'/);
  assert.match(catalog, /'chat\.attachmentCancel': '업로드 취소'/);
  assert.match(catalog, /'chat\.attachmentCancel': 'Cancelar carga'/);
});
