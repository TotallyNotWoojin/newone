// The server half of the live web suite: one real consumer account with
// enough around it that the desktop surfaces have something to show.
//
// Everything here goes through the same hosted gateway the phone apps use
// (tests/hosted/smoke-lib.mjs), so nothing is seeded straight into the
// database and nothing is mocked. The browser then signs in to this account
// through the real sign-in form.
import { randomUUID } from 'node:crypto';

import { makeRunId } from '../../hosted/lib.mjs';
import {
  PERSONAL_REALM_ID,
  PROJECT_URL,
  gatewayPost,
  loadAccessToken,
  projectKeys,
  signupUser,
} from '../../hosted/smoke-lib.mjs';

export { PROJECT_URL };

const dataOf = (response) => response.payload?.data ?? response.payload;

function post(keys, user, path, label, body) {
  return gatewayPost('newone-api', path, keys, {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: `web-e2e-${label}-${randomUUID()}`,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  });
}

function expectStatus(response, expected, what) {
  if (response.status !== expected) {
    throw new Error(`${what} answered ${response.status}: ${JSON.stringify(response.payload).slice(0, 400)}`);
  }
  return dataOf(response);
}

/**
 * Builds the account graph the live specs read:
 *  - `owner`: signs in on the web with a password
 *  - two accepted contacts, so search has people to make chips from and a
 *    group of three is possible
 *  - a direct chat with three messages, one of them pinned
 */
export async function createLiveWorkspace() {
  const supabaseAccessToken = loadAccessToken();
  const keys = projectKeys(supabaseAccessToken);
  const runId = makeRunId();
  const password = `Web-${randomUUID().slice(0, 12)}!`;

  const owner = await signupUser(keys, { runId, label: 'owner', language: 'en', password });
  const friend = await signupUser(keys, { runId, label: 'friend', language: 'en' });
  const third = await signupUser(keys, { runId, label: 'third', language: 'en' });

  const connect = async (target, label, body) => {
    const request = await post(keys, owner, '/v2/contacts/message-requests', `req-${label}`, {
      targetUserId: target.userId,
      body,
    });
    const conversationId = expectStatus(request, 201, `message request to ${label}`)?.conversationId;
    const accept = await post(keys, target, `/v2/contacts/connections/${owner.userId}/respond`, `acc-${label}`, {
      decision: 'accepted',
    });
    expectStatus(accept, 200, `${label} accepting`);
    return String(conversationId);
  };

  const conversationId = await connect(friend, 'friend', `Hello from the web suite ${runId}`);
  await connect(third, 'third', `Hello again from the web suite ${runId}`);

  const send = async (user, label, body) => {
    const response = await post(keys, user, `/v2/conversations/${conversationId}/messages`, label, {
      clientMessageId: randomUUID(),
      kind: 'text',
      body,
    });
    const sent = expectStatus(response, 201, `sending ${label}`);
    return String(sent?.messageId ?? sent?.id ?? '');
  };

  const pinnedBody = 'Ferry at six, bring the tickets';
  const hoverBody = 'This one is only here to be hovered';
  const pinnedMessageId = await send(owner, 'm1', pinnedBody);
  await send(friend, 'm2', 'Understood, see you at the pier');
  await send(owner, 'm3', hoverBody);

  const pin = await post(keys, owner, `/v2/messages/${pinnedMessageId}/pin`, 'pin', {
    conversationId,
    pinned: true,
  });
  expectStatus(pin, 200, 'pinning a message');

  return {
    runId,
    projectUrl: PROJECT_URL,
    owner: { email: owner.email, username: owner.username, password, userId: owner.userId },
    friend: { displayName: 'Smoke friend', username: friend.username, userId: friend.userId },
    third: { displayName: 'Smoke third', username: third.username, userId: third.userId },
    conversationId,
    pinnedBody,
    hoverBody,
  };
}
