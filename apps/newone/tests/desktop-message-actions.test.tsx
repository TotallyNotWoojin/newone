import { describe, expect, jest, test } from '@jest/globals';
import { Platform, Text, type ViewProps } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  desktopMessageProps,
  desktopPointer,
} from '@/features/chat/desktop-message-actions';
import { SwipeToReply } from '@/features/chat/swipe-reply-gesture';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

type MouseProps = ViewProps & {
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onContextMenu?: (event: { preventDefault?: () => void }) => void;
};

describe('what a pointer gets instead of a gesture', () => {
  test('recognises the web build and nothing else', () => {
    expect(desktopPointer('web')).toBe(true);
    expect(desktopPointer('ios')).toBe(false);
    expect(desktopPointer('android')).toBe(false);
  });

  test('reads the running platform when it is not told one', () => {
    // The tests around this one pass a platform; the app does not.
    expect(desktopPointer()).toBe(Platform.OS === 'web');
    const handlers = {
      onHoverChange: jest.fn<(hovered: boolean) => void>(),
      onContextMenu: jest.fn<() => void>(),
    };
    expect(Object.keys(desktopMessageProps(handlers)).length).toBe(Platform.OS === 'web' ? 3 : 0);
  });

  test('a phone build carries no extra props and no extra listeners', () => {
    const handlers = {
      onHoverChange: jest.fn<(hovered: boolean) => void>(),
      onContextMenu: jest.fn<() => void>(),
    };
    expect(desktopMessageProps(handlers, 'ios')).toEqual({});
    expect(desktopMessageProps(handlers, 'android')).toEqual({});
  });

  test('hovering in and out is reported', () => {
    const handlers = {
      onHoverChange: jest.fn<(hovered: boolean) => void>(),
      onContextMenu: jest.fn<() => void>(),
    };
    const props = desktopMessageProps(handlers, 'web') as MouseProps;
    props.onMouseEnter?.();
    expect(handlers.onHoverChange).toHaveBeenLastCalledWith(true);
    props.onMouseLeave?.();
    expect(handlers.onHoverChange).toHaveBeenLastCalledWith(false);
  });

  test('right-click opens our actions rather than the browser’s menu', () => {
    const handlers = {
      onHoverChange: jest.fn<(hovered: boolean) => void>(),
      onContextMenu: jest.fn<() => void>(),
    };
    const props = desktopMessageProps(handlers, 'web') as MouseProps;
    const preventDefault = jest.fn<() => void>();
    props.onContextMenu?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(handlers.onContextMenu).toHaveBeenCalledTimes(1);
  });

  test('a right-click event with nothing on it is still handled', () => {
    const handlers = {
      onHoverChange: jest.fn<(hovered: boolean) => void>(),
      onContextMenu: jest.fn<() => void>(),
    };
    const props = desktopMessageProps(handlers, 'web') as MouseProps;
    props.onContextMenu?.({});
    expect(handlers.onContextMenu).toHaveBeenCalledTimes(1);
  });
});

describe('the reply affordance on a desktop message row', () => {
  const asWeb = (run: () => Promise<void>) => async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      await run();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  };

  test('hover offers Reply, right-click opens the sheet, and a dead message offers neither',
    asWeb(async () => {
      const onReply = jest.fn<() => void>();
      const onOpenActions = jest.fn<() => void>();
      const view = await render(
        <SwipeToReply enabled own={false} onOpenActions={onOpenActions} onReply={onReply}>
          <Text accessibilityLabel="bubble">Lock the north gate at 18:00.</Text>
        </SwipeToReply>,
      );
      expect(view.getByLabelText('bubble')).toBeTruthy();
      expect(view.queryByLabelText('chat.reply')).toBeNull();

      const row = view.getByLabelText('bubble').parent!;
      fireEvent(row, 'mouseEnter');
      await waitFor(() => expect(view.queryByLabelText('chat.reply')).not.toBeNull());
      fireEvent.press(view.getByLabelText('chat.reply'));
      expect(onReply).toHaveBeenCalledTimes(1);

      // Right-click is the long press: the same sheet, and the browser's own
      // menu stays out of the way.
      const preventDefault = jest.fn<() => void>();
      fireEvent(row, 'contextMenu', { preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      expect(onOpenActions).toHaveBeenCalledTimes(1);

      fireEvent(row, 'mouseLeave');
      await waitFor(() => expect(view.queryByLabelText('chat.reply')).toBeNull());

      // A message that cannot be replied to keeps its row and offers nothing,
      // however long the pointer sits on it.
      await view.rerender(
        <SwipeToReply enabled={false} own onOpenActions={onOpenActions} onReply={onReply}>
          <Text accessibilityLabel="bubble">Lock the north gate at 18:00.</Text>
        </SwipeToReply>,
      );
      fireEvent(view.getByLabelText('bubble').parent!, 'mouseEnter');
      await waitFor(() => expect(view.getByLabelText('bubble')).toBeTruthy());
      expect(view.queryByLabelText('chat.reply')).toBeNull();
      expect(onReply).toHaveBeenCalledTimes(1);
    }));
});
