import { Platform } from 'react-native';

type State = {
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
};

/**
 * `accessibilityState` and the aria attributes the browser actually reads.
 *
 * React Native Web announces state from `aria-checked` / `aria-expanded` /
 * `aria-selected` / `aria-disabled`, not from `accessibilityState`, so a
 * control that set only the latter told a screen reader nothing about itself
 * on the web while being correct on a phone. Spread this instead of writing
 * `accessibilityState` by hand and both get told.
 */
export function a11yState(state: State) {
  if (Platform.OS !== 'web') return { accessibilityState: state };
  return {
    accessibilityState: state,
    ...(state.checked === undefined ? {} : { 'aria-checked': state.checked }),
    ...(state.expanded === undefined ? {} : { 'aria-expanded': state.expanded }),
    ...(state.selected === undefined ? {} : { 'aria-selected': state.selected }),
    ...(state.disabled === undefined ? {} : { 'aria-disabled': state.disabled }),
    ...(state.busy === undefined ? {} : { 'aria-busy': state.busy }),
  };
}
