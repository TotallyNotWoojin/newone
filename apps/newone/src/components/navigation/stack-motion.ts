/**
 * One motion budget for every screen change so the app feels quick and
 * consistent: tab-like screens cross-fade, the conversation slides in, and
 * both finish well under the platform default (350 ms on iOS). Reduce Motion
 * turns every transition off.
 */
export const SCREEN_FADE_MS = 150;
export const SCREEN_PUSH_MS = 220;

export type StackMotion = {
  /** Default for every screen: a short cross-fade. */
  screen: { animation: 'fade'; animationDuration: number } | { animation: 'none' };
  /** Drill-in screens (a conversation): a quick slide without the parallax shadow. */
  push: { animation: 'simple_push'; animationDuration: number } | { animation: 'none' };
};

export function stackMotion(reduceMotion: boolean): StackMotion {
  if (reduceMotion) {
    return { screen: { animation: 'none' }, push: { animation: 'none' } };
  }
  return {
    screen: { animation: 'fade', animationDuration: SCREEN_FADE_MS },
    push: { animation: 'simple_push', animationDuration: SCREEN_PUSH_MS },
  };
}
