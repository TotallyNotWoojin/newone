import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type AttachmentScanJob,
  attachmentScanMode,
  type AttachmentScanWorkerDependencies,
  createAttachmentScanWorkerHandler,
  createSignatureOnlyScan,
  defaultAttachmentScanWorkerDependencies,
  parseScannerResponse,
  signatureMimeCandidates,
} from '../newone-attachment-scan-worker/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

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

function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
}

/** A minimal ISO BMFF header: 4-byte box size, 'ftyp', then the major brand. */
function bmffBytes(brand: string): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x00, 0x00, 0x00, 0x18]);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  return bytes;
}

function mediaClaim(declaredMimeType: string, bytes: Uint8Array, digestHex: string) {
  return {
    jobs: [{
      id: 601,
      organization_id: organizationId,
      topic: 'storage_scan',
      payload: {
        attachment_id: attachmentId,
        bucket_id: 'message-attachments',
        storage_path: `${organizationId}/${conversationId}/${userId}/${attachmentId}/upload`,
        byte_size: bytes.byteLength as number,
        sha256_hex: digestHex,
        declared_mime_type: declaredMimeType,
      },
      attempts: 1,
    }],
  };
}

/** Replaces global fetch with a tripwire and reports how often it fired. */
async function withFetchGuard(run: () => Promise<void>): Promise<number> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.reject(new Error('network egress is forbidden in signature-only mode'));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
}

Deno.test('the signature gate recognizes m4a/AAC voice-note containers', () => {
  assertEquals([...signatureMimeCandidates(bmffBytes('M4A '))], ['audio/mp4']);
  assertEquals([...signatureMimeCandidates(bmffBytes('M4B '))], ['audio/mp4']);
  assertEquals([...signatureMimeCandidates(bmffBytes('M4P '))], ['audio/mp4']);
  // Android recorders emit generic ISO BMFF brands for audio/mp4 voice notes.
  assert([...signatureMimeCandidates(bmffBytes('isom'))].includes('audio/mp4'));
  assert([...signatureMimeCandidates(bmffBytes('mp42'))].includes('audio/mp4'));
});

Deno.test('signature-only mode commits clean verdicts without any scanner egress', async () => {
  const cases: Array<[string, Uint8Array]> = [
    ['image/jpeg', jpegBytes()],
    ['video/mp4', bmffBytes('isom')],
    ['audio/mp4', bmffBytes('M4A ')],
    ['audio/mp4', bmffBytes('isom')],
    ['application/pdf', pdfBytes()],
  ];
  for (const [declaredMimeType, bytes] of cases) {
    const digestHex = await sha256Hex(bytes);
    const events: string[] = [];
    const handler = createAttachmentScanWorkerHandler(() =>
      dependencies({
        claim: async () => mediaClaim(declaredMimeType, bytes, digestHex),
        download: async () => bytes,
        scan: createSignatureOnlyScan(),
        complete: async (_workerId, _job, verdict) => {
          events.push(
            `${verdict.result}:${verdict.detectedMimeType}:${verdict.policyCode}:${verdict.scannerName}`,
          );
        },
      })
    );
    let payload: unknown;
    const fetchCalls = await withFetchGuard(async () => {
      const response = await handler(request());
      assertEquals(response.status, 200);
      payload = await response.json();
    });
    assertEquals(fetchCalls, 0, `${declaredMimeType} must not reach the network`);
    assertEquals(payload, { claimed: 1, clean: 1, quarantined: 0, failed: 0 });
    assertEquals(events, [`clean:${declaredMimeType}:null:newone-signature-gate`]);
  }
});

Deno.test('signature-only mode still quarantines mismatched magic bytes without scanner egress', async () => {
  const bytes = jpegBytes();
  const digestHex = await sha256Hex(bytes);
  const events: string[] = [];
  const handler = createAttachmentScanWorkerHandler(() =>
    dependencies({
      claim: async () => mediaClaim('audio/mp4', bytes, digestHex),
      download: async () => bytes,
      scan: createSignatureOnlyScan(),
      complete: async (_workerId, _job, verdict) => {
        events.push(`${verdict.result}:${verdict.detectedMimeType}:${verdict.policyCode}`);
      },
    })
  );
  const fetchCalls = await withFetchGuard(async () => {
    const response = await handler(request());
    assertEquals(response.status, 200);
    assertEquals((await response.json()).quarantined, 1);
  });
  assertEquals(fetchCalls, 0);
  assertEquals(events, ['quarantined:image/jpeg:declared_type_mismatch']);
});

Deno.test('the signature-only scan mirrors the gate verdicts when called directly', async () => {
  const scan = createSignatureOnlyScan();
  const job = (declaredMimeType: string): AttachmentScanJob => ({
    id: '601',
    organizationId,
    attachmentId,
    bucketId: 'message-attachments',
    storagePath: `${organizationId}/${conversationId}/${userId}/${attachmentId}/upload`,
    byteSize: 24,
    sha256Hex: 'a'.repeat(64),
    declaredMimeType,
  });
  assertEquals(await scan(job('audio/mp4'), bmffBytes('M4B '), 'correlation'), {
    result: 'clean',
    detectedMimeType: 'audio/mp4',
    policyCode: null,
    scannerName: 'newone-signature-gate',
    scannerVersion: 'v1',
  });
  const mismatch = await scan(job('image/jpeg'), pngBytes(), 'correlation');
  assertEquals(mismatch.result, 'quarantined');
  assertEquals(mismatch.policyCode, 'declared_type_mismatch');
  assertEquals(mismatch.detectedMimeType, 'image/png');
  const unknown = await scan(job('image/jpeg'), Uint8Array.from([0x00, 0x01, 0x02, 0xff]), 'x');
  assertEquals(unknown.result, 'quarantined');
  assertEquals(unknown.policyCode, 'unrecognized_signature');
  assertEquals(unknown.detectedMimeType, 'application/octet-stream');
});

Deno.test('scan job claims honor the per-type byte caps', async () => {
  const run = async (claim: unknown) => {
    const events: string[] = [];
    const handler = createAttachmentScanWorkerHandler(() =>
      dependencies({
        claim: async () => claim,
        download: async () => bmffBytes('isom'),
        scan: createSignatureOnlyScan(),
        complete: async (_workerId, _job, verdict) => {
          events.push(`${verdict.result}:${verdict.policyCode}`);
        },
      })
    );
    const response = await handler(request());
    return { status: response.status, body: await response.json(), events };
  };

  // A video above the 25 MiB non-video cap is claimable up to 100 MiB. The
  // downloaded fixture is tiny, so the job terminates as a digest mismatch --
  // which proves the claim itself parsed.
  const video = mediaClaim('video/mp4', bmffBytes('isom'), 'a'.repeat(64));
  video.jobs[0]!.payload.byte_size = 26_214_401;
  const oversizedVideoWithinCap = await run(video);
  assertEquals(oversizedVideoWithinCap.status, 200);
  assertEquals(oversizedVideoWithinCap.body.quarantined, 1);
  assertEquals(oversizedVideoWithinCap.events, ['quarantined:digest_mismatch']);

  // Claims above the per-type cap are rejected by the shared integer bounds
  // (a 400 bad_request) before any download or scan can happen.
  const image = mediaClaim('image/jpeg', jpegBytes(), 'a'.repeat(64));
  image.jobs[0]!.payload.byte_size = 26_214_401;
  const oversizedImage = await run(image);
  assertEquals(oversizedImage.status, 400);
  assertEquals(oversizedImage.events, []);

  const hugeVideo = mediaClaim('video/mp4', bmffBytes('isom'), 'a'.repeat(64));
  hugeVideo.jobs[0]!.payload.byte_size = 104_857_601;
  const oversizedVideo = await run(hugeVideo);
  assertEquals(oversizedVideo.status, 400);
  assertEquals(oversizedVideo.events, []);
});

const bootEnvironment: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-scan-mode-tests',
  SUPABASE_SECRET_KEY: 'server-secret-key-for-scan-mode-tests',
  NEWONE_NETWORK_HASH_KEY: 'network-key-that-is-long-enough-for-tests',
  NEWONE_WORKER_TOKEN: workerToken,
};

async function withScanModeEnvironment(
  mode: string | null,
  scannerSecrets: boolean,
  run: () => Promise<void> | void,
): Promise<void> {
  const managed = [
    ...Object.keys(bootEnvironment),
    'NEWONE_ATTACHMENT_SCAN_MODE',
    'NEWONE_ATTACHMENT_SCANNER_URL',
    'NEWONE_ATTACHMENT_SCANNER_TOKEN',
  ];
  const previous = new Map(managed.map((key) => [key, Deno.env.get(key)]));
  try {
    for (const [key, value] of Object.entries(bootEnvironment)) Deno.env.set(key, value);
    if (mode === null) Deno.env.delete('NEWONE_ATTACHMENT_SCAN_MODE');
    else Deno.env.set('NEWONE_ATTACHMENT_SCAN_MODE', mode);
    if (scannerSecrets) {
      Deno.env.set('NEWONE_ATTACHMENT_SCANNER_URL', 'https://scanner.newone.example/v1/scan');
      Deno.env.set('NEWONE_ATTACHMENT_SCANNER_TOKEN', 'scanner-token-that-is-long-enough-for-tests');
    } else {
      Deno.env.delete('NEWONE_ATTACHMENT_SCANNER_URL');
      Deno.env.delete('NEWONE_ATTACHMENT_SCANNER_TOKEN');
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('signature-only mode boots without scanner secrets while external mode fails closed', async () => {
  // Absent mode defaults to external and keeps requiring the scanner secrets.
  await withScanModeEnvironment(null, false, async () => {
    assertEquals(attachmentScanMode(), 'external');
    await assertRejects(
      () => defaultAttachmentScanWorkerDependencies(),
      (error) =>
        error instanceof Error && error.message.includes('NEWONE_ATTACHMENT_SCANNER_URL'),
    );
  });
  await withScanModeEnvironment('external', false, async () => {
    await assertRejects(
      () => defaultAttachmentScanWorkerDependencies(),
      (error) =>
        error instanceof Error && error.message.includes('NEWONE_ATTACHMENT_SCANNER_URL'),
    );
  });
  await withScanModeEnvironment('external', true, () => {
    assert(defaultAttachmentScanWorkerDependencies().workerToken === workerToken);
  });
  await withScanModeEnvironment('clamav-direct', false, async () => {
    await assertRejects(
      () => attachmentScanMode(),
      (error) =>
        error instanceof Error && error.message.includes('NEWONE_ATTACHMENT_SCAN_MODE'),
    );
  });
  await withScanModeEnvironment('signature-only', false, async () => {
    assertEquals(attachmentScanMode(), 'signature-only');
    const bootstrapped = defaultAttachmentScanWorkerDependencies();
    const bytes = bmffBytes('M4A ');
    const job: AttachmentScanJob = {
      id: '601',
      organizationId,
      attachmentId,
      bucketId: 'message-attachments',
      storagePath: `${organizationId}/${conversationId}/${userId}/${attachmentId}/upload`,
      byteSize: bytes.byteLength,
      sha256Hex: await sha256Hex(bytes),
      declaredMimeType: 'audio/mp4',
    };
    const fetchCalls = await withFetchGuard(async () => {
      const verdict = await bootstrapped.scan(job, bytes, 'correlation');
      assertEquals(verdict.result, 'clean');
      assertEquals(verdict.detectedMimeType, 'audio/mp4');
      assertEquals(verdict.scannerName, 'newone-signature-gate');
    });
    assertEquals(fetchCalls, 0);
  });
});
