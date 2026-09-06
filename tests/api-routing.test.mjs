import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  directEdgeRequestHeaders,
  edgeFunctionForPath,
  resolveApiUrl,
  resolveStorageSignedUrl,
  supabaseProjectOrigin,
} from '../apps/newone/src/config/api-routing.mjs';

const projectUrl = 'https://project-ref.supabase.co';
const functionsBase = `${projectUrl}/functions/v1`;

test('native Edge routing inserts the exact function for auth, read, and command paths', () => {
  const cases = [
    ['/v2/auth/invitations/redeem', 'newone-auth'],
    // v3 passwords: missing from the table they routed to the API function (defect AC).
    ['/v2/auth/password/verify', 'newone-auth'],
    ['/v2/auth/native/password/verify', 'newone-auth'],
    ['/v2/auth/password/set', 'newone-auth'],
    // v3.2 account lookup: the first call of every returning sign-in.
    ['/v2/auth/account/lookup', 'newone-auth'],
    ['/v2/auth/native/account/lookup', 'newone-auth'],
    ['/v2/auth/recovery/otp/request', 'newone-auth'],
    ['/v2/auth/native/recovery/otp/verify', 'newone-auth'],
    ['/v2/auth/recovery/cases', 'newone-auth'],
    [
      '/v2/auth/recovery/cases/00000000-0000-4000-8000-000000000001/approve',
      'newone-auth',
    ],
    ['/v2/bootstrap', 'newone-read'],
    ['/v2/search', 'newone-read'],
    ['/v2/admin/audit/query', 'newone-read'],
    ['/v2/conversations/00000000-0000-4000-8000-000000000001/messages/query', 'newone-read'],
    ['/v2/conversations/direct', 'newone-api'],
    ['/v2/admin/role-assignments/query', 'newone-api'],
    ['/v2/admin/audit/export', 'newone-api'],
  ];
  for (const [path, functionName] of cases) {
    assert.equal(edgeFunctionForPath(path), functionName);
    assert.equal(
      resolveApiUrl({ path, platform: 'ios', apiBase: functionsBase, supabaseUrl: projectUrl }),
      `${functionsBase}/${functionName}${path}`,
    );
    assert.equal(
      resolveApiUrl({ path, platform: 'android', apiBase: '/api', supabaseUrl: projectUrl }),
      `${functionsBase}/${functionName}${path}`,
    );
  }
});

test('routing fails closed on arbitrary native API origins and non-api web bases', () => {
  for (const apiBase of [
    'https://api.example.test',
    'https://other-project.supabase.co/functions/v1',
    'http://project-ref.supabase.co/functions/v1',
    'https://user:password@project-ref.supabase.co/functions/v1',
    'https://project-ref.supabase.co/functions/v1?target=other',
    'https://project-ref.supabase.co/evil/functions/v1',
  ]) {
    assert.equal(resolveApiUrl({
      path: '/v2/bootstrap',
      platform: 'ios',
      apiBase,
      supabaseUrl: projectUrl,
    }), null);
  }
  assert.equal(resolveApiUrl({
    path: '/v2/bootstrap', platform: 'web', apiBase: '/api', supabaseUrl: projectUrl,
  }), '/api/v2/bootstrap');
  assert.equal(resolveApiUrl({
    path: '/v2/bootstrap', platform: 'web', apiBase: 'https://api.example.test', supabaseUrl: projectUrl,
  }), null);
  // A direct (bearer) web build is routed like native: to the project's Edge Functions only.
  assert.equal(resolveApiUrl({
    path: '/v2/bootstrap', platform: 'web', apiBase: '/api', supabaseUrl: projectUrl, webDirect: true,
  }), `${functionsBase}/newone-read/v2/bootstrap`);
  assert.equal(resolveApiUrl({
    path: '/v2/auth/native/otp/verify', platform: 'web', apiBase: functionsBase, supabaseUrl: projectUrl, webDirect: true,
  }), `${functionsBase}/newone-auth/v2/auth/native/otp/verify`);
  assert.equal(resolveApiUrl({
    path: '/v2/bootstrap', platform: 'web', apiBase: 'https://api.example.test', supabaseUrl: projectUrl, webDirect: true,
  }), null);
  assert.equal(resolveApiUrl({
    path: '/v2/bootstrap', platform: 'web', apiBase: '/api', supabaseUrl: null, webDirect: true,
  }), null);
  assert.equal(resolveApiUrl({
    path: '/v2/%2e%2e/admin', platform: 'ios', apiBase: functionsBase, supabaseUrl: projectUrl,
  }), null);
  for (const supabaseUrl of [
    '',
    'https://supabase.co',
    'https://project-ref.supabase.co.evil.example',
    'https://nested.project-ref.supabase.co',
    'https://project-ref.supabase.co/project',
    'https://project-ref.supabase.co:444',
  ]) {
    assert.equal(supabaseProjectOrigin(supabaseUrl), null);
    assert.equal(resolveApiUrl({
      path: '/v2/bootstrap', platform: 'ios', apiBase: '/api', supabaseUrl,
    }), null);
  }
  assert.equal(supabaseProjectOrigin(projectUrl), projectUrl);
});

test('native Edge headers never use the publishable key as a bearer credential', () => {
  const publishableKey = 'sb_publishable_synthetic_contract_key_123456';
  const userJwt = 'user.jwt.signature';
  assert.deepEqual(directEdgeRequestHeaders({
    platform: 'ios', publishableKey, accessToken: userJwt,
  }), {
    apikey: publishableKey,
    Authorization: `Bearer ${userJwt}`,
  });
  assert.deepEqual(directEdgeRequestHeaders({
    platform: 'android', publishableKey,
  }), { apikey: publishableKey });
  assert.deepEqual(directEdgeRequestHeaders({
    platform: 'web', publishableKey, accessToken: userJwt,
  }), {});
  assert.deepEqual(directEdgeRequestHeaders({
    platform: 'web', publishableKey, accessToken: userJwt, webDirect: true,
  }), {
    apikey: publishableKey,
    Authorization: `Bearer ${userJwt}`,
  });
  assert.equal(directEdgeRequestHeaders({
    platform: 'web', publishableKey: ['sb', 'secret', 'forbidden', 'credential'].join('_'), webDirect: true,
  }), null);
  assert.equal(directEdgeRequestHeaders({
    platform: 'ios', publishableKey: ['sb', 'secret', 'forbidden', 'credential'].join('_'), accessToken: userJwt,
  }), null);
});

test('attachment grants are constrained to signed Storage routes on the configured project', () => {
  const token = 'synthetic.storage.token_1234567890';
  const upload = `${projectUrl}/storage/v1/object/upload/sign/message-attachments/org/member/file/upload?token=${token}`;
  const download = `${projectUrl}/storage/v1/object/sign/message-attachments/org/file?token=${token}&download=manual.pdf`;
  assert.equal(resolveStorageSignedUrl({ signedUrl: upload, supabaseUrl: projectUrl, action: 'upload' }), upload);
  assert.equal(resolveStorageSignedUrl({ signedUrl: download, supabaseUrl: projectUrl, action: 'download' }), download);

  for (const signedUrl of [
    `https://evil.example/storage/v1/object/upload/sign/message-attachments/file?token=${token}`,
    `${projectUrl}/functions/v1/newone-api?token=${token}`,
    `${projectUrl}/storage/v1/object/sign/message-attachments/file?token=${token}`,
    `${projectUrl}/storage/v1/object/upload/sign/message-attachments/%2e%2e/file?token=${token}`,
    `${projectUrl}/storage/v1/object/upload/sign/message-attachments/file?token=${token}&redirect=https://evil.example`,
    `${projectUrl}/storage/v1/object/upload/sign/message-attachments/file?token=${token}#fragment`,
    `javascript:alert(1)`,
  ]) {
    assert.equal(resolveStorageSignedUrl({ signedUrl, supabaseUrl: projectUrl, action: 'upload' }), null);
  }
  assert.equal(resolveStorageSignedUrl({
    signedUrl: `${projectUrl}/storage/v1/object/sign/message-attachments/file?token=${token}&token=second`,
    supabaseUrl: projectUrl,
    action: 'download',
  }), null);

  const repository = readFileSync(
    'apps/newone/src/data/repositories/bff-command-repository.ts',
    'utf8',
  );
  assert.match(repository, /signedUrl: requiredStorageSignedUrl\(grant\.signedUrl, 'upload'\)/);
  assert.match(repository, /signedUrl: requiredStorageSignedUrl\(grant\.signedUrl, 'download'\)/);
});

test('message send cannot choose recipient translation targets', () => {
  const contracts = readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8');
  const repository = readFileSync(
    'apps/newone/src/data/repositories/bff-command-repository.ts',
    'utf8',
  );
  const sendInput = contracts.slice(
    contracts.indexOf('export interface SendMessageInput'),
    contracts.indexOf('export interface CreateGroupInput'),
  );
  const outboundBody = repository.slice(
    repository.indexOf('async sendMessage(input:'),
    repository.indexOf('const data = dataValue(payload)', repository.indexOf('async sendMessage(input:')),
  );
  assert.doesNotMatch(sendInput, /translationTargets/);
  assert.doesNotMatch(sendInput, /metadata/);
  assert.doesNotMatch(outboundBody, /translationTargets/);
  assert.doesNotMatch(outboundBody, /metadata/);
  assert.match(repository, /rawTranslationTargets/);
});
