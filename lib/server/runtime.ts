import { workerBindings } from "./bindings";

export function runtimeValue(name: string): string | undefined {
  const workerEnv = workerBindings();
  const fromWorker = workerEnv[name];
  if (typeof fromWorker === "string" && fromWorker.trim()) {
    return fromWorker.trim();
  }

  const fromProcess = process.env[name];
  return fromProcess?.trim() || undefined;
}

export function runtimeBoolean(name: string, fallback = false): boolean {
  const value = runtimeValue(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
