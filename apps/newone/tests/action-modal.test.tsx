import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, Text } from 'react-native';

import { ActionModal, SHEET_OPEN_MS } from '@/components/ui/action-modal';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

describe('action modal presentation', () => {
  test('opens in one quick beat instead of the system cross-dissolve, and closes at once', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const onClose = jest.fn();
    const view = await render(
      <ActionModal description="Quiet sheet" onClose={onClose} title="Controls" visible>
        <Text>Sheet body</Text>
      </ActionModal>,
    );
    expect(screen.getByText('Controls')).toBeTruthy();
    expect(screen.getByText('Quiet sheet')).toBeTruthy();
    expect(screen.getByText('Sheet body')).toBeTruthy();

    // The Modal itself no longer animates; the card settles with its own short timing.
    const modal = view.root!;
    expect(modal.props.animationType).toBe('none');
    expect(modal.props.visible).toBe(true);
    expect(SHEET_OPEN_MS).toBeLessThanOrEqual(200);
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 1, duration: SHEET_OPEN_MS, useNativeDriver: true }),
    );

    // The X button and the backdrop both close; closing needs no exit animation to wait for.
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[1]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    expect(onClose).toHaveBeenCalledTimes(2);

    await view.rerender(
      <ActionModal onClose={onClose} title="Controls" visible={false}>
        <Text>Sheet body</Text>
      </ActionModal>,
    );
    expect(screen.queryByText('Sheet body')).toBeNull();
    await view.unmount();
  });
});
