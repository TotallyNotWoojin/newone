import { expect, jest, test } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import type { PanGesture } from 'react-native-gesture-handler';

import { SwipeToReply } from '@/features/chat/swipe-reply-gesture';
import { swipeReplyThresholdPx } from '@/features/chat/swipe-to-reply';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

const bubble = (
  <Text accessibilityLabel="bubble">Lock the north gate at 18:00.</Text>
);

test('a swipe past the threshold replies to the message', async () => {
  const onReply = jest.fn<() => void>();
  await render(
    <SwipeToReply enabled own={false} onReply={onReply} onOpenActions={jest.fn<() => void>()}>
      {bubble}
    </SwipeToReply>,
  );
  expect(screen.getByLabelText('bubble')).toBeTruthy();

  fireGestureHandler<PanGesture>(getByGestureTestId('swipe-to-reply'), [
    { translationX: 0, translationY: 0 },
    { translationX: 30, translationY: 2 },
    { translationX: swipeReplyThresholdPx + 12, translationY: 4 },
  ]);

  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
});

test('a swipe released short of the threshold replies to nothing', async () => {
  const onReply = jest.fn<() => void>();
  await render(
    <SwipeToReply enabled own onReply={onReply} onOpenActions={jest.fn<() => void>()}>
      {bubble}
    </SwipeToReply>,
  );

  fireGestureHandler<PanGesture>(getByGestureTestId('swipe-to-reply'), [
    { translationX: 0, translationY: 0 },
    { translationX: 12, translationY: 1 },
    { translationX: swipeReplyThresholdPx - 20, translationY: 2 },
  ]);

  await waitFor(() => expect(screen.getByLabelText('bubble')).toBeTruthy());
  expect(onReply).not.toHaveBeenCalled();
});

test('a message that cannot be replied to still renders, gesture and all', async () => {
  const onReply = jest.fn<() => void>();
  await render(
    <SwipeToReply enabled={false} own={false} onReply={onReply} onOpenActions={jest.fn<() => void>()}>
      {bubble}
    </SwipeToReply>,
  );
  expect(screen.getByLabelText('bubble')).toBeTruthy();
  expect(onReply).not.toHaveBeenCalled();
});
