type WorkerBindings = Record<string, unknown>;

type BindingGlobal = typeof globalThis & {
  __NEWONE_RELAY_WORKER_BINDINGS__?: WorkerBindings;
};

export function setWorkerBindings(bindings: WorkerBindings): void {
  (globalThis as BindingGlobal).__NEWONE_RELAY_WORKER_BINDINGS__ = bindings;
}

export function workerBindings(): WorkerBindings {
  return (globalThis as BindingGlobal).__NEWONE_RELAY_WORKER_BINDINGS__ ?? {};
}
