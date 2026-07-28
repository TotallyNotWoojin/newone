import { drizzle } from "drizzle-orm/d1";
import { workerBindings } from "../lib/server/bindings";
import * as schema from "./schema";

export function getDb() {
  const binding = workerBindings().DB as D1Database | undefined;
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(binding, { schema });
}
