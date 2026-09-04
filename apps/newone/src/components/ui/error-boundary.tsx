import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  children: ReactNode;
  labels: { title: string; retry: string };
  scope: string;
};

type State = { error: Error | null };

/**
 * Turns a render-time failure inside a screen into a visible card with the error
 * identifier, instead of the release build terminating. The retry button remounts
 * the subtree; the identifier lets a tester report the exact failure.
 */
export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[screen:${this.props.scope}] render failure`, error, info.componentStack ?? '');
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const identifier = `${error.name}: ${error.message}`.slice(0, 400);
    return (
      <View accessibilityRole="alert" style={styles.card} testID="screen-error">
        <Text style={styles.title}>{this.props.labels.title}</Text>
        <Text selectable style={styles.identifier}>{identifier}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => this.setState({ error: null })}
          style={styles.button}>
          <Text style={styles.buttonLabel}>{this.props.labels.retry}</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  card: {
    margin: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    gap: spacing.sm,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  identifier: { color: colors.inkMuted, fontSize: 13 },
  button: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.forest,
  },
  buttonLabel: { color: '#FFFFFF', fontWeight: '600' },
});
