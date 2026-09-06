import { describe, expect, test } from '@jest/globals';

import { SCREEN_FADE_MS, SCREEN_PUSH_MS, stackMotion } from '@/components/navigation/stack-motion';

describe('stack motion budget', () => {
  test('keeps every transition quick, consistent, and under the platform default', () => {
    const motion = stackMotion(false);
    expect(motion.screen).toEqual({ animation: 'fade', animationDuration: SCREEN_FADE_MS });
    expect(motion.push).toEqual({ animation: 'simple_push', animationDuration: SCREEN_PUSH_MS });
    expect(SCREEN_FADE_MS).toBeLessThanOrEqual(200);
    expect(SCREEN_PUSH_MS).toBeLessThanOrEqual(250);
    expect(SCREEN_PUSH_MS).toBeGreaterThanOrEqual(SCREEN_FADE_MS);
  });

  test('turns every transition off under Reduce Motion', () => {
    expect(stackMotion(true)).toEqual({ screen: { animation: 'none' }, push: { animation: 'none' } });
  });
});
