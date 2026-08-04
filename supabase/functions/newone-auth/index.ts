import { createAuthHandler } from './handler.ts';

Deno.serve(createAuthHandler());
