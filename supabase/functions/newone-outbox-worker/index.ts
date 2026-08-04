import { createOutboxWorkerHandler } from './handler.ts';

Deno.serve(createOutboxWorkerHandler());
