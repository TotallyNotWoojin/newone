import type { AuthenticatedActor } from '../_shared/clients.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const reportId = '20000000-0000-4000-8000-000000000002';
const summaryId = '30000000-0000-4000-8000-000000000003';
const exampleId = '40000000-0000-4000-8000-000000000004';

Deno.test('AI output intake accepts one exact target and strict consent fields', async () => {
  const route = matchRoute('POST', '/v2/ai-output-error-reports');
  assert(route);
  assertEquals(route.requireAal2, undefined);
  assertEquals(
    parseCommand(route, {
      organizationId,
      outputKind: 'translation',
      translationId: '42',
      summaryId: null,
      category: 'incorrect_meaning',
      details: 'The translated instruction reverses the direction.',
      highConsequence: true,
      qualityUseConsent: false,
      consentVersion: 'quality-use-consent-v1',
    }).values.translationId,
    '42',
  );
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      outputKind: 'summary',
      translationId: '42',
      summaryId,
      category: 'unsupported_claim',
      details: 'The claim has no source.',
      highConsequence: false,
      qualityUseConsent: true,
      consentVersion: 'quality-use-consent-v1',
    })
  );
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      outputKind: 'translation',
      translationId: '42',
      category: 'unsupported_claim',
      details: 'Wrong category for this output.',
      highConsequence: false,
      qualityUseConsent: false,
      consentVersion: 'quality-use-consent-v1',
    })
  );
});

Deno.test('AI regression export is not exposed as a client route', () => {
  assertEquals(matchRoute('POST', '/v2/ai-regression-examples/claim'), null);
  assertEquals(matchRoute('POST', '/v2/ai-regression-examples/export'), null);
});

Deno.test('AI output routes map only to their scoped public BFF RPCs', async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const actor = {
    user: { id: '50000000-0000-4000-8000-000000000005' },
    claims: {
      sub: '50000000-0000-4000-8000-000000000005',
      sessionId: '60000000-0000-4000-8000-000000000006',
      aal: 'aal2',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: {}, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const cases = [
    ['/v2/ai-output-error-reports/self/query', { organizationId, limit: 5 }],
  ] as const;
  for (const [path, body] of cases) {
    const route = matchRoute('POST', path);
    assert(route);
    await executeCommand(route, parseCommand(route, body), actor, '', 'a'.repeat(64));
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_list_my_ai_output_error_reports',
  ]);
  assert(!calls.some((call) => call.name.includes('claim')));
});
