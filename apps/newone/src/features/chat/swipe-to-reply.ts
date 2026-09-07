/**
 * The arithmetic behind "drag a bubble to the right to reply to it".
 *
 * Kept apart from the gesture so it can be reasoned about and tested on its
 * own: how far the bubble follows the finger, when the arrow has faded in, when
 * releasing counts as a reply, and — the part that matters most — when a drag is
 * horizontal enough to be a reply at all rather than the list being scrolled.
 */

/** Past this, releasing sends the reply. Short, like iMessage's. */
export const swipeReplyThresholdPx = 56;

/** The bubble never travels further than this, however hard it is pulled. */
export const swipeReplyMaxTravelPx = 76;

/** Below this the finger has not moved enough to mean anything. */
export const swipeReplyMinIntentPx = 8;

/**
 * How far right the bubble sits for a finger this far right.
 *
 * A leftward drag moves nothing — this gesture is one-way. Past the threshold
 * the bubble keeps moving but at a third of the speed, so the finger can run on
 * without the bubble sliding across the screen.
 */
export function swipeReplyTranslation(dx: number): number {
  'worklet';
  if (!Number.isFinite(dx) || dx <= 0) return 0;
  if (dx <= swipeReplyThresholdPx) return dx;
  const overshoot = (dx - swipeReplyThresholdPx) / 3;
  return Math.min(swipeReplyMaxTravelPx, swipeReplyThresholdPx + overshoot);
}

/** Releasing here replies; releasing short of it snaps the bubble back. */
export function swipeReplyTriggered(dx: number): boolean {
  'worklet';
  return Number.isFinite(dx) && dx >= swipeReplyThresholdPx;
}

/**
 * The reply arrow under the bubble: invisible at rest, fully drawn by the time
 * the drag would trigger, so the arrow itself says how far is far enough.
 */
export function swipeReplyArrowOpacity(dx: number): number {
  'worklet';
  if (!Number.isFinite(dx) || dx <= swipeReplyMinIntentPx) return 0;
  const progress = (dx - swipeReplyMinIntentPx) / (swipeReplyThresholdPx - swipeReplyMinIntentPx);
  return Math.min(1, Math.max(0, progress));
}

/**
 * Whether this drag belongs to the reply gesture rather than to the message
 * list scrolling under it. The finger has to have gone a useful distance to the
 * right and to be travelling more sideways than up or down; anything else stays
 * with the list, which is the one that must never feel sticky.
 */
export function swipeReplyClaimsGesture(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  if (dx < swipeReplyMinIntentPx) return false;
  return dx > Math.abs(dy);
}

/** A message can be replied to unless it is gone or has not been sent yet. */
export function swipeReplyAvailable(
  message: { serverId?: string; deleted?: boolean; systemEvent?: unknown },
): boolean {
  return Boolean(message.serverId) && !message.deleted && !message.systemEvent;
}
