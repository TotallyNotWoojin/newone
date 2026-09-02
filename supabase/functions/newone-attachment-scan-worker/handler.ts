import {
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { safeEqual, sha256Hex } from '../_shared/crypto.ts';
import { ApiError, asApiError } from '../_shared/errors.ts';
import {
  buildRequestMeta,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
} from '../_shared/http.ts';
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import {
  asObject,
  integer,
  normalizedString,
  oneOf,
  onlyKeys,
  uuid,
} from '../_shared/validation.ts';

const MAX_ATTACHMENT_BYTES = 26_214_400;
const MAX_VIDEO_ATTACHMENT_BYTES = 104_857_600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
]);
const VIDEO_ATTACHMENT_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);

function maxAttachmentBytes(mimeType: string): number {
  return VIDEO_ATTACHMENT_MIME_TYPES.has(mimeType)
    ? MAX_VIDEO_ATTACHMENT_BYTES
    : MAX_ATTACHMENT_BYTES;
}

export interface AttachmentScanJob {
  id: string;
  organizationId: string;
  attachmentId: string;
  bucketId: 'message-attachments';
  storagePath: string;
  byteSize: number;
  sha256Hex: string;
  declaredMimeType: string;
}

export interface ScannerVerdict {
  result: 'clean' | 'quarantined';
  detectedMimeType: string;
  policyCode: string | null;
  scannerName: string;
  scannerVersion: string;
}

export interface AttachmentScanWorkerDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  workerToken: string;
  setCorrelationId?(correlationId: string): void;
  claim(workerId: string, limit: number): Promise<unknown>;
  download(job: AttachmentScanJob): Promise<Uint8Array>;
  scan(job: AttachmentScanJob, bytes: Uint8Array, correlationId: string): Promise<ScannerVerdict>;
  complete(workerId: string, job: AttachmentScanJob, verdict: ScannerVerdict): Promise<void>;
  fail(workerId: string, job: AttachmentScanJob, failureCode: string): Promise<void>;
}

function requiredSecret(name: string, minimum: number): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimum) throw new Error(`${name} is not configured`);
  return value;
}

export type AttachmentScanMode = 'external' | 'signature-only';

/**
 * NEWONE_ATTACHMENT_SCAN_MODE selects how a downloaded attachment is judged:
 * 'external' (the default when the variable is absent) requires the external
 * scanner URL/token secrets and fails closed without them; 'signature-only'
 * runs entirely on the built-in magic-byte verification and needs no scanner
 * secrets. Any other value refuses to boot.
 */
export function attachmentScanMode(): AttachmentScanMode {
  const value = Deno.env.get('NEWONE_ATTACHMENT_SCAN_MODE')?.trim() ?? '';
  if (value === '' || value === 'external') return 'external';
  if (value === 'signature-only') return 'signature-only';
  throw new Error(
    "NEWONE_ATTACHMENT_SCAN_MODE must be 'external' or 'signature-only'",
  );
}

function scannerUrl(): string {
  const raw = requiredSecret('NEWONE_ATTACHMENT_SCANNER_URL', 12);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('NEWONE_ATTACHMENT_SCANNER_URL must be a credential-free HTTPS URL');
  }
  return url.toString();
}

export async function parseScannerResponse(
  response: Response,
  expectedDigest: string,
  declaredMimeType: string,
): Promise<ScannerVerdict> {
  if (!response.ok) throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 16_384) throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  let row: Record<string, unknown>;
  try {
    row = asObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    onlyKeys(row, [
      'result',
      'digestSha256',
      'detectedMimeType',
      'polyglotDetected',
      'scannerName',
      'scannerVersion',
    ]);
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  }
  if (row.digestSha256 !== expectedDigest) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  }
  const scannerResult = oneOf(row.result, ['clean', 'infected'] as const);
  const detectedMimeType = normalizedString(row.detectedMimeType, { min: 3, max: 160 }) as string;
  if (!MIME_PATTERN.test(detectedMimeType)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  }
  const polyglotDetected = row.polyglotDetected === true;
  if (typeof row.polyglotDetected !== 'boolean') {
    throw new ApiError(503, 'dependency_unavailable', undefined, 60);
  }
  const policyCode = scannerResult === 'infected'
    ? 'malware_detected'
    : polyglotDetected
    ? 'polyglot_detected'
    : !ALLOWED_ATTACHMENT_MIME_TYPES.has(detectedMimeType)
    ? 'detected_type_disallowed'
    : detectedMimeType !== declaredMimeType
    ? 'declared_type_mismatch'
    : null;
  return {
    result: policyCode === null ? 'clean' : 'quarantined',
    detectedMimeType,
    policyCode,
    scannerName: normalizedString(row.scannerName, { min: 2, max: 120 }) as string,
    scannerVersion: normalizedString(row.scannerVersion, { min: 1, max: 120 }) as string,
  };
}

/**
 * The v1 stand-in for the external malware scanner: the attachment is clean
 * exactly when its content signature family matches the declared MIME type.
 * Failures keep the same quarantine policy codes the pre-egress signature
 * gate emits, so verdict shapes are identical across both scan modes. No
 * network egress happens here.
 */
export function createSignatureOnlyScan(): AttachmentScanWorkerDependencies['scan'] {
  return (job, bytes) => {
    const candidates = signatureMimeCandidates(bytes);
    if (!candidates.has(job.declaredMimeType)) {
      return Promise.resolve<ScannerVerdict>({
        result: 'quarantined',
        detectedMimeType: candidates.values().next().value ?? 'application/octet-stream',
        policyCode: candidates.size === 0 ? 'unrecognized_signature' : 'declared_type_mismatch',
        scannerName: 'newone-signature-gate',
        scannerVersion: 'v1',
      });
    }
    return Promise.resolve<ScannerVerdict>({
      result: 'clean',
      detectedMimeType: job.declaredMimeType,
      policyCode: null,
      scannerName: 'newone-signature-gate',
      scannerVersion: 'v1',
    });
  };
}

export function defaultAttachmentScanWorkerDependencies(): AttachmentScanWorkerDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const workerToken = requiredSecret('NEWONE_WORKER_TOKEN', 32);
  const externalScanner = attachmentScanMode() === 'external'
    ? { url: scannerUrl(), token: requiredSecret('NEWONE_ATTACHMENT_SCANNER_TOKEN', 32) }
    : null;
  let admin = createAdminClient(clientEnvironment);
  return {
    runtimeConfig,
    clientEnvironment,
    workerToken,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    claim(workerId, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_claim_attachment_scan_jobs', {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: 300,
      });
    },
    async download(job) {
      const bucket = admin.storage.from(job.bucketId);
      const { data: info, error: infoError } = await bucket.info(job.storagePath);
      if (infoError || !info) throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      if (info.size !== job.byteSize) throw new ApiError(422, 'attachment_integrity_failed');
      const { data, error } = await bucket.download(job.storagePath);
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      if (data.size !== job.byteSize || data.size > maxAttachmentBytes(job.declaredMimeType)) {
        throw new ApiError(422, 'attachment_integrity_failed');
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    scan: externalScanner === null ? createSignatureOnlyScan() : async (
      job,
      bytes,
      correlationId,
    ) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await fetch(externalScanner.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${externalScanner.token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.byteLength),
            'X-Newone-Attachment-Id': job.attachmentId,
            'X-Newone-Content-Sha256': job.sha256Hex,
            'X-Newone-Correlation-Id': correlationId,
          },
          body: Uint8Array.from(bytes).buffer,
        });
        return await parseScannerResponse(response, job.sha256Hex, job.declaredMimeType);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      } finally {
        clearTimeout(timeout);
      }
    },
    async complete(workerId, job, verdict) {
      await invokeRpc(asRpcClient(admin), 'bff_complete_attachment_scan', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_attachment_id: job.attachmentId,
        p_scan_result: verdict.result,
        p_detected_mime_type: verdict.detectedMimeType,
        p_policy_code: verdict.policyCode,
        p_scanner_name: verdict.scannerName,
        p_scanner_version: verdict.scannerVersion,
      });
    },
    async fail(workerId, job, failureCode) {
      await invokeRpc(asRpcClient(admin), 'bff_fail_attachment_scan', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_attachment_id: job.attachmentId,
        p_failure_code: failureCode.slice(0, 120),
        p_scanner_name: 'newone-scan-gateway',
        p_scanner_version: 'v1',
      });
    },
  };
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function authenticateWorker(
  request: Request,
  expectedWorkerToken: string,
  expectedServerKey: string,
): void {
  const apiKey = request.headers.get('apikey') ?? '';
  const workerToken = request.headers.get('x-newone-worker-token') ?? '';
  if (
    request.headers.has('authorization') || !safeEqual(apiKey, expectedServerKey) ||
    !safeEqual(workerToken, expectedWorkerToken)
  ) throw new ApiError(401, 'unauthorized');
  if (request.headers.has('cookie') || request.headers.has('origin')) {
    throw new ApiError(403, 'forbidden');
  }
}

function positiveBigint(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(503, 'dependency_unavailable');
  return text;
}

function parseJobs(value: unknown): AttachmentScanJob[] {
  const envelope = asObject(value);
  if (!Array.isArray(envelope.jobs) || envelope.jobs.length > 3) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  return envelope.jobs.map((entry) => {
    const row = asObject(entry);
    onlyKeys(row, ['id', 'organization_id', 'topic', 'payload', 'attempts']);
    if (row.topic !== 'storage_scan') throw new ApiError(503, 'dependency_unavailable');
    const payload = asObject(row.payload);
    onlyKeys(payload, [
      'attachment_id',
      'bucket_id',
      'storage_path',
      'byte_size',
      'sha256_hex',
      'declared_mime_type',
    ]);
    const organizationId = uuid(row.organization_id);
    const attachmentId = uuid(payload.attachment_id);
    if (payload.bucket_id !== 'message-attachments') {
      throw new ApiError(503, 'dependency_unavailable');
    }
    const storagePath = normalizedString(payload.storage_path, {
      min: 1,
      max: 1024,
      trim: false,
    }) as string;
    const parts = storagePath.split('/');
    if (
      parts.length !== 5 || parts[0] !== organizationId || parts[3] !== attachmentId ||
      parts[4] !== 'upload'
    ) throw new ApiError(503, 'dependency_unavailable');
    uuid(parts[1]);
    uuid(parts[2]);
    const sha256 = normalizedString(payload.sha256_hex, { min: 64, max: 64 }) as string;
    if (!SHA256_PATTERN.test(sha256)) throw new ApiError(503, 'dependency_unavailable');
    const declaredMimeType = normalizedString(payload.declared_mime_type, {
      min: 3,
      max: 160,
    }) as string;
    if (
      !MIME_PATTERN.test(declaredMimeType) || !ALLOWED_ATTACHMENT_MIME_TYPES.has(declaredMimeType)
    ) {
      throw new ApiError(503, 'dependency_unavailable');
    }
    return {
      id: positiveBigint(row.id),
      organizationId,
      attachmentId,
      bucketId: 'message-attachments',
      storagePath,
      byteSize: integer(payload.byte_size, 1, maxAttachmentBytes(declaredMimeType)),
      sha256Hex: sha256,
      declaredMimeType,
    };
  });
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiWindow(bytes: Uint8Array, maximum = 2_000_000): string {
  const bounded = bytes.subarray(0, Math.min(bytes.byteLength, maximum));
  return new TextDecoder('latin1').decode(bounded);
}

/**
 * A local, intentionally conservative signature gate. In 'external' mode the
 * scanner's detected MIME and polyglot verdict remain mandatory and this gate
 * prevents a caller from reaching it with an obviously mislabeled
 * executable/container; in 'signature-only' mode this same sniffing is the
 * verdict authority and a declared type outside its candidate set is what
 * quarantines a mislabeled upload.
 */
export function signatureMimeCandidates(bytes: Uint8Array): ReadonlySet<string> {
  const candidates = new Set<string>();
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) candidates.add('image/jpeg');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    candidates.add('image/png');
  }
  if (
    bytes.byteLength >= 12 && asciiWindow(bytes.subarray(0, 12), 12).slice(0, 4) === 'RIFF' &&
    asciiWindow(bytes.subarray(8, 12), 4) === 'WEBP'
  ) candidates.add('image/webp');
  if (asciiWindow(bytes.subarray(0, 5), 5) === '%PDF-') candidates.add('application/pdf');
  if (asciiWindow(bytes.subarray(0, 4), 4) === 'OggS') candidates.add('audio/ogg');
  if (
    asciiWindow(bytes.subarray(0, 3), 3) === 'ID3' ||
    (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) candidates.add('audio/mpeg');

  if (bytes.byteLength >= 12 && asciiWindow(bytes.subarray(4, 8), 4) === 'ftyp') {
    const brand = asciiWindow(bytes.subarray(8, 12), 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      candidates.add('image/heic');
    } else if (['M4A ', 'M4B ', 'M4P '].includes(brand)) {
      candidates.add('audio/mp4');
    } else if (['qt  '].includes(brand)) {
      candidates.add('video/quicktime');
    } else {
      // Generic ISO BMFF brands (isom/mp42/...) do not distinguish an
      // audio-only container from a video track, so both remain candidates:
      // the external scanner provides the exact type in 'external' mode, and
      // 'signature-only' mode accepts either declared media type.
      candidates.add('audio/mp4');
      candidates.add('video/mp4');
    }
  }

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = asciiWindow(bytes);
    if (names.includes('[Content_Types].xml') && names.includes('word/')) {
      candidates.add('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
    if (names.includes('[Content_Types].xml') && names.includes('xl/')) {
      candidates.add('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // The compound-file directory is parsed by the scanner. Locally retain
    // only the two explicitly allowed legacy Office possibilities.
    candidates.add('application/msword');
    candidates.add('application/vnd.ms-excel');
  }

  if (candidates.size === 0 && bytes.byteLength > 0) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.includes('\u0000')) {
        candidates.add('text/plain');
        candidates.add('text/csv');
      }
    } catch {
      // Unknown binary types stay empty and are quarantined before egress.
    }
  }
  return candidates;
}

async function processJob(
  dependencies: AttachmentScanWorkerDependencies,
  workerId: string,
  correlationId: string,
  job: AttachmentScanJob,
): Promise<'clean' | 'quarantined' | 'failed'> {
  try {
    const bytes = await dependencies.download(job);
    if (bytes.byteLength !== job.byteSize || await sha256Hex(bytes) !== job.sha256Hex) {
      const verdict: ScannerVerdict = {
        result: 'quarantined',
        detectedMimeType: 'application/octet-stream',
        policyCode: 'digest_mismatch',
        scannerName: 'newone-integrity',
        scannerVersion: 'v1',
      };
      await dependencies.complete(workerId, job, verdict);
      return 'quarantined';
    }
    const signatureCandidates = signatureMimeCandidates(bytes);
    if (!signatureCandidates.has(job.declaredMimeType)) {
      await dependencies.complete(workerId, job, {
        result: 'quarantined',
        detectedMimeType: signatureCandidates.values().next().value ?? 'application/octet-stream',
        policyCode: signatureCandidates.size === 0
          ? 'unrecognized_signature'
          : 'declared_type_mismatch',
        scannerName: 'newone-signature-gate',
        scannerVersion: 'v1',
      });
      return 'quarantined';
    }
    const verdict = await dependencies.scan(job, bytes, correlationId);
    await dependencies.complete(workerId, job, verdict);
    return verdict.result;
  } catch (error) {
    const safe = asApiError(error);
    try {
      if (safe.code === 'attachment_integrity_failed') {
        await dependencies.complete(workerId, job, {
          result: 'quarantined',
          detectedMimeType: 'application/octet-stream',
          policyCode: 'digest_mismatch',
          scannerName: 'newone-integrity',
          scannerVersion: 'v1',
        });
        return 'quarantined';
      }
      await dependencies.fail(workerId, job, safe.code);
    } catch {
      // The database lease remains authoritative; never report success when a
      // terminal state could not be committed.
    }
    console.error(JSON.stringify({
      event: 'newone_attachment_scan_failed',
      correlation_id: correlationId,
      job_id: job.id,
      code: safe.code,
    }));
    return 'failed';
  }
}

export function createAttachmentScanWorkerHandler(
  dependencyFactory: () => AttachmentScanWorkerDependencies =
    defaultAttachmentScanWorkerDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: AttachmentScanWorkerDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      ensureSecureTransport(request, dependencies.runtimeConfig);
      meta = buildRequestMeta(request, dependencies.runtimeConfig);
      dependencies.setCorrelationId?.(meta.requestId);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      authenticateWorker(
        request,
        dependencies.workerToken,
        dependencies.clientEnvironment.secretKey,
      );
      const body = asObject((await parseJson(request, dependencies.runtimeConfig)).value);
      onlyKeys(body, ['limit']);
      const limit = body.limit === undefined ? 2 : integer(body.limit, 1, 3);
      const workerId = crypto.randomUUID();
      const jobs = parseJobs(await dependencies.claim(workerId, limit));
      const counts = { clean: 0, quarantined: 0, failed: 0 };
      for (const job of jobs) {
        counts[await processJob(dependencies, workerId, meta.requestId, job)] += 1;
      }
      return jsonResponse(meta, 200, { claimed: jobs.length, ...counts });
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_attachment_scan_worker_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
