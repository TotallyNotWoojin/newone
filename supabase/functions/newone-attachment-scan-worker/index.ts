import { createAttachmentScanWorkerHandler } from './handler.ts';

Deno.serve(createAttachmentScanWorkerHandler());
