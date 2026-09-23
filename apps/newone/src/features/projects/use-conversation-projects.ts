import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { ConversationProjects, ProjectCommand } from '@/data/repositories/contracts';
import { useWorkspace } from '@/state/workspace';

/**
 * One copy of each chat's projects, shared by every place that shows them:
 * the sidebar tree, the Projects sheet, the "Saving to" bar and the summary
 * sheet. A chat reloads when its version changes: a realtime hint about the
 * chat or a project command from this device (the workspace's revision), or
 * the newest message settling here (a send confirmed, a photo finished
 * uploading), since whatever this reader sends may have been filed. Four
 * components mounting together make one request, and an older answer never
 * overwrites a newer one.
 */
const store = new Map<string, ConversationProjects>();
const loadedVersion = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();
const issued = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam and sign-out: forget every chat's projects. */
export function resetConversationProjectsStore() {
  store.clear();
  loadedVersion.clear();
  inflight.clear();
  issued.clear();
  emit();
}

function load(
  key: string,
  conversationId: string,
  version: string,
  reader: (conversationId: string) => Promise<ConversationProjects | null>,
  force = false,
): Promise<void> {
  if (!force && loadedVersion.get(key) === version && store.has(key)) return Promise.resolve();
  const requestKey = `${key}#${version}`;
  const running = inflight.get(requestKey);
  if (running && !force) return running;
  const ticket = (issued.get(key) ?? 0) + 1;
  issued.set(key, ticket);
  const request = reader(conversationId).then((projects) => {
    inflight.delete(requestKey);
    if (!projects || issued.get(key) !== ticket) return;
    loadedVersion.set(key, version);
    store.set(key, projects);
    emit();
  });
  inflight.set(requestKey, request);
  return request;
}

export function useConversationProjects(conversationId: string | null | undefined) {
  const workspace = useWorkspace();
  const userId = workspace.currentUser?.id ?? '';
  const key = conversationId && userId ? `${userId}:${conversationId}` : '';
  const revision = conversationId ? workspace.projectRevisions?.[conversationId] ?? 0 : 0;
  const tail = conversationId ? workspace.messages?.[conversationId]?.at(-1) : undefined;
  const version = `${revision}|${tail?.serverId ?? ''}|${tail?.attachment?.status ?? ''}`;
  const projects = useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) ?? null : null),
    () => null,
  );
  const reader = workspace.loadConversationProjects;
  const runCommand = workspace.runProjectCommand;

  useEffect(() => {
    if (!key || !conversationId) return;
    void load(key, conversationId, version, reader);
  }, [conversationId, key, reader, version]);

  const reload = useCallback(() => {
    if (!key || !conversationId) return Promise.resolve();
    return load(key, conversationId, version, reader, true);
  }, [conversationId, key, reader, version]);

  const run = useCallback(
    async (command: ProjectCommand) => {
      if (!conversationId) return null;
      return await runCommand(conversationId, command);
    },
    [conversationId, runCommand],
  );

  const selectedProject = projects?.projects.find((project) => project.id === projects.selectedProjectId) ?? null;
  return { projects, selectedProject, reload, run };
}
