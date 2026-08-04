import { createPushReceiptWorkerHandler } from './handler.ts';

Deno.serve(createPushReceiptWorkerHandler());
