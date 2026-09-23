/**
 * The browser's own word on the network. Off the web (and in a browser that
 * cannot tell) both helpers stay out of the way: nothing is reported offline
 * and no listener is registered.
 */
export function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Calls `listener` each time the browser says the network is back. Returns the unsubscribe. */
export function onNetworkReturn(listener: () => void): () => void {
  const target = typeof window !== 'undefined' ? window : undefined;
  if (!target || typeof target.addEventListener !== 'function') return () => undefined;
  target.addEventListener('online', listener);
  return () => target.removeEventListener('online', listener);
}
