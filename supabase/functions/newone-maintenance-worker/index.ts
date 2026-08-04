import { createMaintenanceWorkerHandler } from './handler.ts';

Deno.serve(createMaintenanceWorkerHandler());
