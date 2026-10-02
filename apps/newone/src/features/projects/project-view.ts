import { useSyncExternalStore } from 'react';

import type { Message } from '@/domain/types';

/**
 * Which project's conversation a chat is showing on its own (owner's father,
 * Oct 1 2026: "since multiple project conversations happen on the same
 * screen, it's very inconvenient to follow the discussions"). Opening a
 * project from the sidebar, the Projects sheet or the bar over the composer
 * sets it; "Show all" clears it. It lives for the session, per chat, and the
 * timeline and the projects tree read the same copy.
 */
export interface ProjectView {
  projectId: string;
  /** When the reader opened it: what they send from here on is saved there. */
  since: number;
}

const views = new Map<string, ProjectView>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function showProject(conversationId: string, projectId: string | null, now = Date.now()) {
  const current = views.get(conversationId);
  if (projectId === null) {
    if (!current) return;
    views.delete(conversationId);
  } else {
    if (current?.projectId === projectId) return;
    views.set(conversationId, { projectId, since: now });
  }
  for (const listener of listeners) listener();
}

export function useProjectView(conversationId: string | null | undefined): ProjectView | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? views.get(conversationId) ?? null : null),
    () => null,
  );
}

/** Test seam and sign-out. */
export function resetProjectViews() {
  views.clear();
  for (const listener of listeners) listener();
}

// The server's list arrives a moment after a message lands; until then the
// timeline knows enough on its own not to make a message blink out and back.
const OWN_CLOCK_SLACK_MS = 5000;

/**
 * A project's conversation out of the chat's messages (oldest first): the ones
 * the server lists for it, the reader's own messages sent since opening it
 * (they are saved there) unless the server has filed them in another project,
 * and answers to anything already in it, the way the server files them.
 */
export function projectConversation(
  messages: readonly Message[],
  messageIds: readonly string[],
  since: number,
  elsewhere: ReadonlySet<string> = new Set(),
): Message[] {
  const listed = new Set(messageIds);
  const included = new Set<string>();
  const shown: Message[] = [];
  for (const message of messages) {
    const key = message.serverId ?? message.id;
    const sentAt = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    const ownHere = message.isOwn && !message.systemEvent && !elsewhere.has(key)
      && (!message.serverId || (Number.isFinite(sentAt) && sentAt >= since - OWN_CLOCK_SLACK_MS));
    const answer = Boolean(message.replyTo?.messageId && included.has(message.replyTo.messageId));
    if (listed.has(key) || ownHere || answer) {
      included.add(key);
      shown.push(message);
    }
  }
  return shown;
}
