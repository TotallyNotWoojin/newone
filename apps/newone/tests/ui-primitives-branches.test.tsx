import { fireEvent, render, screen } from '@testing-library/react-native';
import { describe, expect, jest, test } from '@jest/globals';

import {
  Avatar,
  Chip,
  EmptyState,
  IconButton,
  PrimaryButton,
  SearchField,
  SectionEyebrow,
  StatusBadge,
} from '@/components/ui/primitives';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('reusable UI primitive state matrices', () => {
  test('renders every avatar source and presence state including the default size', async () => {
    await render(<>
      <Avatar initials="IM" color="#111111" imageUri="https://images.newone.test/avatar.png" presence="online" />
      <Avatar initials="IC" color="#222222" icon="megaphone" presence="away" size={32} />
      <Avatar initials="TX" color="#333333" presence="offline" size={80} />
    </>);
    expect(screen.getByText('TX')).toBeTruthy();
  });

  test('covers button enablement, loading, icon, press, and fallback states', async () => {
    const onPress = jest.fn();
    await render(<>
      <IconButton name="add" label="Enabled icon" onPress={onPress} tone="accent" />
      <IconButton name="trash" label="Disabled icon" disabled tone="danger" />
      <PrimaryButton label="Ready" onPress={onPress} icon="checkmark" tone="dark" />
      <PrimaryButton label="Loading" onPress={onPress} loading tone="light" />
      <PrimaryButton label="Unavailable" tone="danger" />
    </>);
    await fireEvent(screen.getByRole('button', { name: 'Enabled icon' }), 'pressIn');
    await fireEvent.press(screen.getByRole('button', { name: 'Enabled icon' }));
    await fireEvent(screen.getByRole('button', { name: 'Ready' }), 'pressIn');
    await fireEvent.press(screen.getByRole('button', { name: 'Ready' }));
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Loading' }).props.accessibilityState.disabled).toBe(true);
  });

  test('covers searchable input clear labels and compact/default layouts', async () => {
    const onChange = jest.fn();
    const onSubmit = jest.fn();
    const view = await render(<SearchField
      compact
      onChangeText={onChange}
      onSubmitEditing={onSubmit}
      placeholder="Search controlled"
      value="query"
    />);
    await fireEvent.press(screen.getByLabelText('common.clearSearch'));
    expect(onChange).toHaveBeenCalledWith('');
    await fireEvent(screen.getByLabelText('Search controlled'), 'submitEditing');
    expect(onSubmit).toHaveBeenCalled();

    await view.rerender(<SearchField
      clearLabel="Clear custom"
      onChangeText={onChange}
      placeholder="Search empty"
      value=""
    />);
    expect(screen.queryByLabelText('Clear custom')).toBeNull();
  });

  test('covers chips, badges, empty states, and styled eyebrow content', async () => {
    const onPress = jest.fn();
    await render(<>
      <Chip accessibilityLabel="Selected chip" count={3} icon="star" label="Selected" onPress={onPress} selected />
      <Chip count={0} label="Plain" />
      <StatusBadge icon="warning" label="Warning" tone="warning" />
      <StatusBadge label="Neutral" />
      <EmptyState action={<SectionEyebrow>Action content</SectionEyebrow>} body="Nothing here" icon="search" title="Empty" />
    </>);
    await fireEvent(screen.getByRole('button', { name: 'Selected chip' }), 'pressIn');
    await fireEvent.press(screen.getByRole('button', { name: 'Selected chip' }));
    expect(onPress).toHaveBeenCalled();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Action content')).toBeTruthy();
  });
});
