import { describe, expect, jest, test } from '@jest/globals';
import { Vibration } from 'react-native';

import { replyHapticTick } from '@/features/chat/reply-haptics';
import {
  swipeReplyArrowOpacity,
  swipeReplyAvailable,
  swipeReplyClaimsGesture,
  swipeReplyMaxTravelPx,
  swipeReplyMinIntentPx,
  swipeReplyThresholdPx,
  swipeReplyTranslation,
  swipeReplyTriggered,
} from '@/features/chat/swipe-to-reply';

describe('how far the bubble follows the finger', () => {
  test('stays put for a leftward drag, because the gesture is one-way', () => {
    expect(swipeReplyTranslation(-40)).toBe(0);
    expect(swipeReplyTranslation(-1)).toBe(0);
    expect(swipeReplyTranslation(0)).toBe(0);
  });

  test('follows the finger exactly up to the threshold', () => {
    expect(swipeReplyTranslation(10)).toBe(10);
    expect(swipeReplyTranslation(swipeReplyThresholdPx)).toBe(swipeReplyThresholdPx);
  });

  test('slows down past the threshold and never runs away', () => {
    const justPast = swipeReplyTranslation(swipeReplyThresholdPx + 30);
    expect(justPast).toBeGreaterThan(swipeReplyThresholdPx);
    expect(justPast).toBeLessThan(swipeReplyThresholdPx + 30);
    expect(swipeReplyTranslation(400)).toBe(swipeReplyMaxTravelPx);
    expect(swipeReplyTranslation(4000)).toBe(swipeReplyMaxTravelPx);
  });

  test('never returns nonsense for nonsense', () => {
    expect(swipeReplyTranslation(Number.NaN)).toBe(0);
    expect(swipeReplyTranslation(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('when releasing replies', () => {
  test('a short drag snaps back', () => {
    expect(swipeReplyTriggered(0)).toBe(false);
    expect(swipeReplyTriggered(swipeReplyThresholdPx - 1)).toBe(false);
    expect(swipeReplyTriggered(-200)).toBe(false);
    expect(swipeReplyTriggered(Number.NaN)).toBe(false);
  });

  test('reaching the threshold is enough', () => {
    expect(swipeReplyTriggered(swipeReplyThresholdPx)).toBe(true);
    expect(swipeReplyTriggered(swipeReplyThresholdPx + 200)).toBe(true);
  });
});

describe('the arrow revealed under the finger', () => {
  test('is invisible until the drag means something', () => {
    expect(swipeReplyArrowOpacity(0)).toBe(0);
    expect(swipeReplyArrowOpacity(swipeReplyMinIntentPx)).toBe(0);
    expect(swipeReplyArrowOpacity(-50)).toBe(0);
    expect(swipeReplyArrowOpacity(Number.NaN)).toBe(0);
  });

  test('fades in across the drag and is fully drawn when releasing would reply', () => {
    const half = swipeReplyArrowOpacity((swipeReplyMinIntentPx + swipeReplyThresholdPx) / 2);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(swipeReplyArrowOpacity(swipeReplyThresholdPx)).toBe(1);
    expect(swipeReplyArrowOpacity(swipeReplyThresholdPx + 40)).toBe(1);
  });
});

describe('not fighting the list underneath', () => {
  test('leaves a scroll alone', () => {
    expect(swipeReplyClaimsGesture(2, 40)).toBe(false);
    expect(swipeReplyClaimsGesture(0, -80)).toBe(false);
    expect(swipeReplyClaimsGesture(30, 30)).toBe(false);
    expect(swipeReplyClaimsGesture(30, -44)).toBe(false);
  });

  test('takes a drag that is clearly sideways', () => {
    expect(swipeReplyClaimsGesture(30, 4)).toBe(true);
    expect(swipeReplyClaimsGesture(60, -20)).toBe(true);
  });

  test('waits for the finger to have gone somewhere', () => {
    expect(swipeReplyClaimsGesture(swipeReplyMinIntentPx - 1, 0)).toBe(false);
    expect(swipeReplyClaimsGesture(swipeReplyMinIntentPx, 0)).toBe(true);
    expect(swipeReplyClaimsGesture(Number.NaN, 0)).toBe(false);
    expect(swipeReplyClaimsGesture(20, Number.NaN)).toBe(false);
  });
});

describe('which messages can be swiped', () => {
  test('a sent, live, ordinary message can', () => {
    expect(swipeReplyAvailable({ serverId: 'message-1' })).toBe(true);
  });

  test('a queued, deleted or system message cannot', () => {
    expect(swipeReplyAvailable({ serverId: undefined })).toBe(false);
    expect(swipeReplyAvailable({ serverId: 'message-1', deleted: true })).toBe(false);
    expect(swipeReplyAvailable({ serverId: 'message-1', systemEvent: { eventType: 'x' } })).toBe(false);
  });
});

describe('the tick when the swipe passes its threshold', () => {
  test('taps the vibrator briefly on Android', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    replyHapticTick('android');
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  test('stays silent where the only vibration would be a long buzz', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    replyHapticTick('ios');
    replyHapticTick('web');
    expect(vibrate).not.toHaveBeenCalled();
  });
});
