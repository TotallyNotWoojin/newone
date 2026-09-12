// Builds the account the store screenshots are taken of.
//
// Store art has to show a populated, plausible app, and the thing worth
// advertising here is that two people who do not share a language are having
// one conversation. So this makes a small cast with different reading
// languages and has them talk, rather than seeding rows: every message below
// goes through the same hosted gateway the phones use, so the translation the
// screenshots show is the real pipeline's output.
//
// Usage:  node tests/device/lib/showcase-account.mjs
// Prints the NEWONE_SHOT_* environment the capture areas expect.
import { randomUUID } from 'node:crypto';

import { makeRunId } from '../../hosted/lib.mjs';
import {
  PERSONAL_REALM_ID,
  adminRequest,
  gatewayPost,
  gatewayRequest,
  loadAccessToken,
  projectKeys,
} from '../../hosted/smoke-lib.mjs';

const dataOf = (response) => response.payload?.data ?? response.payload;

// Idempotency keys are validated as /^[A-Za-z0-9._:-]+$/, so a label taken
// from a display name ("Diego Ruiz") is a 400, not a bad key.
const slug = (value) => String(value).replace(/[^A-Za-z0-9._:-]+/g, '-');

async function call(keys, user, method, path, label, body) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await gatewayRequest('newone-api', method, path, keys, {
      installationId: user.installationId,
      accessToken: user.accessToken,
      idempotencyKey: `showcase-${slug(label)}-${randomUUID()}`,
      body: { organizationId: PERSONAL_REALM_ID, ...body },
    });
    // Contact requests are rate limited per account; the showcase makes several
    // in a row, so wait the window out rather than failing the run.
    if (response.status !== 429 || attempt >= 3) return response;
    const wait = Number(response.payload?.error?.retryAfterSeconds ?? 60) + 5;
    console.log(`  rate limited, waiting ${wait}s`);
    await new Promise((resolve) => { setTimeout(resolve, wait * 1000); });
  }
}

function expect(response, status, what) {
  if (response.status !== status) {
    throw new Error(`${what} answered ${response.status}: ${JSON.stringify(response.payload).slice(0, 300)}`);
  }
  return dataOf(response);
}

/**
 * Signup with a chosen handle. The shared smoke helper mints `e2e_<label>_<hex>`
 * usernames, and the handle is printed under the title on the Chats screen, so
 * a store screenshot taken with one reads as a test build. The username cannot
 * be changed afterwards -- no route accepts it -- so it has to be right here.
 */
async function signupNamed(keys, { email, username, displayName, language, password }) {
  const installationId = randomUUID();
  const request = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
    installationId,
    body: {
      destination: email,
      username,
      displayName,
      language,
      installationId,
      captchaToken: 'hosted-smoke-captcha-placeholder',
      ...(password ? { password } : {}),
    },
  });
  const status = request.payload?.data?.status ?? request.payload?.status;
  if (request.status !== 202 || status !== 'code_sent') {
    throw new Error(`signup for ${username} refused (${request.status}): ${JSON.stringify(request.payload).slice(0, 200)}`);
  }
  const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const otp = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
  if (!/^[0-9]{6,10}$/.test(otp)) throw new Error(`no OTP for ${username}`);
  const verify = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
    installationId,
    body: { destination: email, code: otp, installationId },
  });
  if (verify.status !== 200) {
    throw new Error(`verify for ${username} failed (${verify.status})`);
  }
  const data = verify.payload?.data ?? verify.payload ?? {};
  return { email, username, userId: data.user?.id, installationId, accessToken: data.session?.accessToken };
}

/** The cast. Languages differ on purpose: that is the product. */
const CAST = [
  { label: 'owner', name: 'Maya Chen', handle: 'mayachen', language: 'en' },
  { label: 'diego', name: 'Diego Ruiz', handle: 'diegoruiz', language: 'es' },
  { label: 'jisoo', name: 'Park Ji-soo', handle: 'jisoopark', language: 'ko' },
];

export async function buildShowcase({ log = console.log } = {}) {
  const keys = projectKeys(loadAccessToken());
  const runId = makeRunId();
  const password = `Shot-${randomUUID().slice(0, 12)}!`;

  const people = {};
  for (const member of CAST) {
    // Handles are unique forever, so each run suffixes them; keep it short so
    // the header still reads as a person's handle.
    const suffix = runId.slice(-4);
    const user = await signupNamed(keys, {
      email: `${runId}-${member.label}@example.test`,
      username: `${member.handle}${suffix}`,
      displayName: member.name,
      language: member.language,
      ...(member.label === 'owner' ? { password } : {}),
    });
    people[member.label] = { ...user, name: member.name, label: member.label };
    log(`  ${member.name.padEnd(13)} ${user.email}`);
  }

  const owner = people.owner;

  const connect = async (target, opening) => {
    const request = await call(keys, owner, 'POST', '/v2/contacts/message-requests', `req-${target.label}`, {
      targetUserId: target.userId,
      body: opening,
    });
    const conversationId = expect(request, 201, `message request to ${target.name}`)?.conversationId;
    expect(
      await call(keys, target, 'POST', `/v2/contacts/connections/${owner.userId}/respond`, `acc-${target.label}`, {
        decision: 'accepted',
      }),
      200,
      `${target.name} accepting`,
    );
    return String(conversationId);
  };

  const say = async (user, conversationId, body) => {
    const sent = await call(keys, user, 'POST', `/v2/conversations/${conversationId}/messages`, 'msg', {
      clientMessageId: randomUUID(),
      kind: 'text',
      body,
    });
    expect(sent, 201, `${user.name} sending`);
    // Give the translation worker room; the screenshot is worthless without it.
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
  };

  // The headline conversation: Maya writes English, Diego writes Spanish.
  const withDiego = await connect(people.diego, 'Hola Maya, ¿seguimos con lo del sábado?');
  await say(owner, withDiego, 'Yes — are we still on for Saturday?');
  await say(people.diego, withDiego, 'Claro. ¿Nos vemos en la estación a las diez?');
  await say(owner, withDiego, 'Ten works. I will bring the tickets.');
  await say(people.diego, withDiego, 'Perfecto, llevo el café. Hasta el sábado.');

  const withJisoo = await connect(people.jisoo, '마야, 사진 고마워요!');
  await say(people.jisoo, withJisoo, '주말에 시간 괜찮으면 같이 가요.');
  await say(owner, withJisoo, 'I would love to. Send me the address?');

  const group = await call(keys, owner, 'POST', '/v2/conversations/group', 'group', {
    kind: 'group',
    name: 'Saturday trip',
    // The creator is added by the database and must not appear here.
    memberAssignments: [
      { membershipId: people.diego.userId, role: 'member' },
      { membershipId: people.jisoo.userId, role: 'member' },
    ],
  });
  const groupId = String(expect(group, 201, 'creating the group')?.conversationId ?? '');
  if (groupId) {
    await say(owner, groupId, 'Adding you both here so nothing gets lost.');
    await say(people.diego, groupId, 'Buenísimo. Yo me encargo de las entradas.');
    await say(people.jisoo, groupId, '저는 간식 준비할게요!');
  }

  return {
    runId,
    email: owner.email,
    password,
    peer: people.diego.name,
    people: Object.fromEntries(Object.values(people).map((p) => [p.name, p.email])),
    conversations: { withDiego, withJisoo, group: groupId },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const showcase = await buildShowcase();
  console.log('\nexport NEWONE_SHOT_EMAIL=' + showcase.email);
  console.log("export NEWONE_SHOT_PASSWORD='" + showcase.password + "'");
  console.log("export NEWONE_SHOT_PEER='" + showcase.peer + "'");
}
