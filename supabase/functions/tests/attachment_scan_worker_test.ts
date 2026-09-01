import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type AttachmentScanWorkerDependencies,
  createAttachmentScanWorkerHandler,
  parseScannerResponse,
  signatureMimeCandidates,
} from '../newone-attachment-scan-worker/handler.ts';
import { assertEquals } from './assert.ts';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};
const workerToken = 'worker-token-that-is-at-least-32-characters';
const serverKey = 'server-secret-key';
const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000030';
const userId = '00000000-0000-4000-8000-000000000010';
const attachmentId = '00000000-0000-4000-8000-000000000060';
const source = new TextEncoder().encode('test attachment bytes');
const digest = await sha256Hex(source);

function claimedJob() {
  return {
    jobs: [{
      id: 501,
      organization_id: organizationId,
      topic: 'storage_scan',
      payload: {
        attachment_id: attachmentId,
        bucket_id: 'message-attachments',
        storage_path: `${organizationId}/${conversationId}/${userId}/${attachmentId}/upload`,
        byte_size: source.byteLength,
        sha256_hex: digest,
        declared_mime_type: 'text/plain',
      },
      attempts: 1,
    }],
  };
}

function dependencies(
  overrides: Partial<AttachmentScanWorkerDependencies> = {},
): AttachmentScanWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: serverKey,
    },
    workerToken,
    claim: async () => claimedJob(),
    download: async () => source,
    scan: async () => ({
      result: 'clean',
      detectedMimeType: 'text/plain',
      policyCode: null,
      scannerName: 'clamav',
      scannerVersion: '1.4.3',
    }),
    complete: async () => {},
    fail: async () => {},
    ...overrides,
  };
}

function request(workerSecret = workerToken): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-attachment-scan-worker', {
    method: 'POST',
    headers: {
      apikey: serverKey,
      'X-Newone-Worker-Token': workerSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 1 }),
  });
}

Deno.test('attachment scanner commits a clean result only after digest verification', async () => {
  const events: string[] = [];
  const handler = createAttachmentScanWorkerHandler(() =>
    dependencies({
      scan: async () => {
        events.push('scan');
        return {
          result: 'clean',
          detectedMimeType: 'text/plain',
          policyCode: null,
          scannerName: 'clamav',
          scannerVersion: '1.4.3',
        };
      },
      complete: async (_workerId, _job, verdict) => {
        events.push(`complete:${verdict.result}`);
      },
      fail: async () => {
        events.push('fail');
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimed: 1,
    clean: 1,
    quarantined: 0,
    failed: 0,
  });
  assertEquals(events, ['scan', 'complete:clean']);
});

Deno.test('attachment scanner quarantines a storage digest mismatch without external scanning', async () => {
  const events: string[] = [];
  const handler = createAttachmentScanWorkerHandler(() =>
    dependencies({
      download: async () => new TextEncoder().encode('tampered bytes'),
      scan: async () => {
        events.push('scan');
        return {
          result: 'clean',
          detectedMimeType: 'text/plain',
          policyCode: null,
          scannerName: 'clamav',
          scannerVersion: '1.4.3',
        };
      },
      complete: async (_workerId, _job, verdict) => {
        events.push(`complete:${verdict.result}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, ['complete:quarantined']);
  assertEquals((await response.json()).quarantined, 1);
});

Deno.test('attachment scanner fails closed when its scanner dependency is unavailable', async () => {
  const events: string[] = [];
  const handler = createAttachmentScanWorkerHandler(() =>
    dependencies({
      scan: async () => {
        throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      },
      complete: async () => {
        events.push('complete');
      },
      fail: async (_workerId, _job, code) => {
        events.push(`fail:${code}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, ['fail:dependency_unavailable']);
  assertEquals((await response.json()).failed, 1);

  let claimed = false;
  const unauthorized = createAttachmentScanWorkerHandler(() =>
    dependencies({
      claim: async () => {
        claimed = true;
        return claimedJob();
      },
    })
  );
  assertEquals((await unauthorized(request('wrong-worker-token'))).status, 401);
  assertEquals(claimed, false);
});

Deno.test('attachment signature gate quarantines a declared media mismatch before scanner egress', async () => {
  const envelope = claimedJob();
  envelope.jobs[0]!.payload.declared_mime_type = 'image/png';
  const events: string[] = [];
  const handler = createAttachmentScanWorkerHandler(() =>
    dependencies({
      claim: async () => envelope,
      scan: async () => {
        events.push('scanner-called');
        return {
          result: 'clean',
          detectedMimeType: 'image/png',
          policyCode: null,
          scannerName: 'clamav',
          scannerVersion: '1.4.3',
        };
      },
      complete: async (_workerId, _job, verdict) => {
        events.push(`${verdict.result}:${verdict.detectedMimeType}:${verdict.policyCode}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, ['quarantined:text/plain:declared_type_mismatch']);
  assertEquals((await response.json()).quarantined, 1);
});

Deno.test('scanner polyglot and detected-MIME mismatch verdicts cannot be promoted to clean', async () => {
  const polyglot = await parseScannerResponse(
    new Response(
      JSON.stringify({
        result: 'clean',
        digestSha256: digest,
        detectedMimeType: 'text/plain',
        polyglotDetected: true,
        scannerName: 'content-inspector',
        scannerVersion: '2.0.0',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    digest,
    'text/plain',
  );
  assertEquals(polyglot.result, 'quarantined');
  assertEquals(polyglot.policyCode, 'polyglot_detected');

  const mismatch = await parseScannerResponse(
    new Response(
      JSON.stringify({
        result: 'clean',
        digestSha256: digest,
        detectedMimeType: 'application/pdf',
        polyglotDetected: false,
        scannerName: 'content-inspector',
        scannerVersion: '2.0.0',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    digest,
    'text/plain',
  );
  assertEquals(mismatch.result, 'quarantined');
  assertEquals(mismatch.policyCode, 'declared_type_mismatch');

  // A detected video is an allowed type now, so a declared audio/mp4 that is
  // really a video quarantines as a declaration mismatch, not as disallowed.
  const declaredAudioActualVideo = await parseScannerResponse(
    new Response(
      JSON.stringify({
        result: 'clean',
        digestSha256: digest,
        detectedMimeType: 'video/mp4',
        polyglotDetected: false,
        scannerName: 'content-inspector',
        scannerVersion: '2.0.0',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    digest,
    'audio/mp4',
  );
  assertEquals(declaredAudioActualVideo.result, 'quarantined');
  assertEquals(declaredAudioActualVideo.policyCode, 'declared_type_mismatch');

  const cleanVideo = await parseScannerResponse(
    new Response(
      JSON.stringify({
        result: 'clean',
        digestSha256: digest,
        detectedMimeType: 'video/mp4',
        polyglotDetected: false,
        scannerName: 'content-inspector',
        scannerVersion: '2.0.0',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    digest,
    'video/mp4',
  );
  assertEquals(cleanVideo.result, 'clean');
  assertEquals(cleanVideo.policyCode, null);

  const disallowedVideo = await parseScannerResponse(
    new Response(
      JSON.stringify({
        result: 'clean',
        digestSha256: digest,
        detectedMimeType: 'video/x-msvideo',
        polyglotDetected: false,
        scannerName: 'content-inspector',
        scannerVersion: '2.0.0',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    digest,
    'video/x-msvideo',
  );
  assertEquals(disallowedVideo.result, 'quarantined');
  assertEquals(disallowedVideo.policyCode, 'detected_type_disallowed');
  assertEquals([...signatureMimeCandidates(source)], ['text/plain', 'text/csv']);
});
