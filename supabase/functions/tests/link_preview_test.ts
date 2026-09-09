// Backlog 47(g): link previews are fetched by the gateway, once per address,
// and kept. The address comes from a member, so the interesting tests are the
// ones about what we refuse to fetch: anything but https, anything with
// credentials, and anything pointing back inside the network — including
// through a redirect, which is the oldest trick there is.
import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import {
  fetchLinkPreview,
  fetchPreviewImage,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_BYTES,
  normalizePreviewUrl,
  parseLinkPreview,
  privatePreviewHost,
} from '../_shared/link-preview.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';

const actor = {
  user: { id: actorId },
  claims: { sub: actorId, sessionId, aal: 'aal1', issuedAt: 1, expiresAt: 9999999999 },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const previewRoute = () => {
  const route = matchRoute('POST', '/v2/link-previews/query');
  assert(route, 'the link preview route must exist');
  return route;
};

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

Deno.test('the route is a query, not a command, and needs no idempotency key', () => {
  const route = previewRoute();
  assertEquals(route.kind, 'message.link_preview');
  assertEquals(route.idempotencyRequired, false);
  assertEquals(route.requireAal2, undefined);
});

Deno.test('only a public https address is accepted', () => {
  assertEquals(normalizePreviewUrl('https://example.com/a#b'), 'https://example.com/a');
  assertEquals(normalizePreviewUrl(' https://example.com/a '), 'https://example.com/a');
  for (
    const value of [
      'http://example.com/a',
      'ftp://example.com/a',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:secret@example.com/',
      'https://localhost/admin',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://[::1]/',
      'https://printer.local/',
      'https://metadata.google.internal/',
      'https://intranet/',
      '',
      'not a url',
      42,
      null,
      `https://example.com/${'a'.repeat(2100)}`,
    ]
  ) {
    let thrown: unknown;
    try {
      normalizePreviewUrl(value);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof ApiError, `${JSON.stringify(value)} must be refused`);
    assertEquals((thrown as ApiError).status, 400);
  }
});

Deno.test('the private-host list covers the shapes that point back inside', () => {
  for (
    const host of [
      'localhost',
      'app.localhost',
      'db.local',
      'thing.internal',
      'router.home.arpa',
      'box.localdomain',
      'metadata.google.internal',
      '169.254.169.254',
      '192.168.0.1',
      'fd00::1',
      'nodot',
      '',
    ]
  ) assert(privatePreviewHost(host), `${host} must be refused`);
  for (const host of ['example.com', 'news.example.co.uk', 'a-b.example.org']) {
    assert(!privatePreviewHost(host), `${host} must be allowed`);
  }
});

Deno.test('a page is read for its title, its site, and nothing else', () => {
  const preview = parseLinkPreview(
    `<html><head>
      <meta property="og:title" content="The north gate is closed">
      <meta property="og:site_name" content="Example &amp; Co">
      <meta property="og:image" content="/thumb.jpg">
      <title>ignored once og:title is there</title>
    </head><body>...</body></html>`,
    'https://example.com/story',
  );
  assertEquals(preview.title, 'The north gate is closed');
  assertEquals(preview.siteName, 'Example & Co');
  assertEquals(preview.imageUrl, 'https://example.com/thumb.jpg');
  assertEquals(preview.status, 'ready');
});

Deno.test('a page falls back to its <title>, and to nothing at all', () => {
  const withTitle = parseLinkPreview('<html><head><title>  Plain\n page </title></head></html>', 'https://example.com/');
  assertEquals(withTitle.title, 'Plain page');
  assertEquals(withTitle.status, 'ready');
  const withNothing = parseLinkPreview('<html><body>no head</body></html>', 'https://example.com/');
  assertEquals(withNothing.title, null);
  assertEquals(withNothing.status, 'unavailable');
});

Deno.test('a thumbnail that points inside the network is dropped, not stored', () => {
  const preview = parseLinkPreview(
    '<html><head><title>t</title><meta property="og:image" content="http://169.254.169.254/latest"></head></html>',
    'https://example.com/',
  );
  assertEquals(preview.imageUrl, null);
});

Deno.test('a long title is cut rather than stored whole', () => {
  const preview = parseLinkPreview(
    `<html><head><title>${'a'.repeat(500)}</title></head></html>`,
    'https://example.com/',
  );
  assert((preview.title ?? '').length <= 200);
  assert((preview.title ?? '').endsWith('…'));
});

Deno.test('a redirect is followed, and re-checked at every hop', async () => {
  const asked: string[] = [];
  const preview = await fetchLinkPreview('https://example.com/a', (url) => {
    asked.push(url);
    if (url === 'https://example.com/a') {
      return Promise.resolve(new Response(null, { status: 301, headers: { location: 'https://example.com/b' } }));
    }
    return Promise.resolve(htmlResponse('<html><head><title>Landed</title></head></html>'));
  });
  assertEquals(asked, ['https://example.com/a', 'https://example.com/b']);
  assertEquals(preview.title, 'Landed');
  assertEquals(preview.url, 'https://example.com/b');
});

Deno.test('a redirect into the network gets nothing, quietly', async () => {
  const asked: string[] = [];
  const preview = await fetchLinkPreview('https://example.com/a', (url) => {
    asked.push(url);
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
  });
  assertEquals(asked, ['https://example.com/a']);
  assertEquals(preview.status, 'unavailable');
  assertEquals(preview.title, null);
});

Deno.test('a page that is gone, slow, huge or not a page is simply unavailable', async () => {
  const cases: Array<() => Promise<Response>> = [
    () => Promise.resolve(new Response('nope', { status: 404 })),
    () => Promise.reject(new Error('network down')),
    () => Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    () => Promise.resolve(htmlResponse('<html><head><title>t</title></head></html>', {
      'content-length': String(MAX_PREVIEW_BYTES * 10),
    })),
    () => Promise.resolve(new Response(null, { status: 301 })),
  ];
  for (const respond of cases) {
    const preview = await fetchLinkPreview('https://example.com/a', () => respond());
    assertEquals(preview.status, 'unavailable', 'a bad page must never fail the reader');
    assertEquals(preview.title, null);
  }
});

Deno.test('the route refuses an address it will not fetch, before any request', async () => {
  const route = previewRoute();
  assertEquals(
    parseCommand(route, { organizationId, url: 'https://example.com/story#top' }).values,
    { url: 'https://example.com/story' },
  );
  for (
    const url of ['http://example.com/', 'https://127.0.0.1/', 'https://user:p@example.com/', 'nope']
  ) await assertRejects(() => parseCommand(route, { organizationId, url }));
  await assertRejects(() => parseCommand(route, { organizationId }));
  await assertRejects(() => parseCommand(route, { organizationId, url: 'https://example.com/', extra: 1 }));
});

Deno.test('a cached address is answered from the cache without fetching anything', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            url: 'https://example.com/story',
            title: 'The north gate is closed',
            site_name: 'Example Daily',
            image_url: null,
            status: 'ready',
            fetched_at: '2026-09-08T02:00:00.000Z',
            cached: true,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = previewRoute();
  const result = await executeCommand(
    route,
    parseCommand(route, { organizationId, url: 'https://example.com/story' }),
    rpcActor,
    '',
    'a'.repeat(64),
  );
  assertEquals(result.status, 200);
  assertEquals(calls.map((call) => call.name), ['bff_link_preview_lookup']);
  const args = calls[0]?.args ?? {};
  assertEquals(args.p_actor_user_id, actorId);
  assertEquals(args.p_organization_id, organizationId);
  assertEquals(args.p_session_id, sessionId);
  assert(/^[0-9a-f]{64}$/.test(String(args.p_url_sha256)), 'the cache key is a sha256 digest');
  assert(!('p_url' in args), 'the lookup never carries the raw address');
  assertEquals(
    (result.body as Record<string, unknown>).title,
    'The north gate is closed',
  );
  assertEquals((result.body as Record<string, unknown>).siteName, 'Example Daily');
});

const imageResponse = (body: Uint8Array, type: string, extra: HeadersInit = {}) =>
  new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': type, ...extra },
  });

Deno.test('a thumbnail is fetched here, so the phone never reaches the site', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = await fetchPreviewImage(
    'https://example.com/a.png',
    () => Promise.resolve(imageResponse(bytes, 'image/png')),
  );
  assertEquals(image?.mime, 'image/png');
  assertEquals(image?.extension, 'png');
  assertEquals(image?.bytes.length, bytes.length);
});

Deno.test('the type is taken from what arrived, not from what was claimed', async () => {
  // A .png address serving HTML is not a thumbnail.
  const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
  assertEquals(
    await fetchPreviewImage(
      'https://example.com/a.png',
      () => Promise.resolve(imageResponse(html, 'text/html')),
    ),
    null,
  );
  // Nor is an image type we do not serve.
  assertEquals(
    await fetchPreviewImage(
      'https://example.com/a.svg',
      () => Promise.resolve(imageResponse(new Uint8Array([1]), 'image/svg+xml')),
    ),
    null,
  );
});

Deno.test('a thumbnail cannot be a private address, directly or by redirect', async () => {
  assertEquals(await fetchPreviewImage('https://127.0.0.1/a.png', () => {
    throw new Error('the fetch must never happen');
  }), null);
  assertEquals(await fetchPreviewImage('http://example.com/a.png', () => {
    throw new Error('plain http must never be fetched');
  }), null);

  let hops = 0;
  const redirected = await fetchPreviewImage('https://example.com/a.png', () => {
    hops += 1;
    return Promise.resolve(new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    }));
  });
  assertEquals(redirected, null);
  assertEquals(hops, 1);
});

Deno.test('a thumbnail the reader would pay for is no thumbnail', async () => {
  // Declared too large: refused before a byte is read.
  assertEquals(
    await fetchPreviewImage('https://example.com/a.png', () =>
      Promise.resolve(imageResponse(new Uint8Array([1]), 'image/png', {
        'content-length': String(MAX_PREVIEW_IMAGE_BYTES + 1),
      }))),
    null,
  );
  // Lying about its size does not help: what arrived is measured too.
  assertEquals(
    await fetchPreviewImage('https://example.com/a.png', () =>
      Promise.resolve(imageResponse(new Uint8Array(MAX_PREVIEW_IMAGE_BYTES + 1), 'image/png'))),
    null,
  );
  // And an empty body is not an image.
  assertEquals(
    await fetchPreviewImage('https://example.com/a.png', () =>
      Promise.resolve(imageResponse(new Uint8Array(0), 'image/png'))),
    null,
  );
});

Deno.test('a hostile thumbnail never fails the reader', async () => {
  assertEquals(
    await fetchPreviewImage('https://example.com/a.png', () => Promise.reject(new Error('gone'))),
    null,
  );
});
