import type { ReactNode } from 'react';
import { Keyboard, Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Tapping anywhere that is not a control puts the on-screen keyboard away.
 *
 * A browser gets a plain View instead. There is no on-screen keyboard to
 * dismiss with a mouse, and react-native-web's Pressable claims the pointer
 * event that would otherwise focus a text input inside it — wrapping the
 * Chats and Contacts screens in one made both search fields impossible to
 * click into on the web app (owner, Sep 11 2026).
 */
export function KeyboardDismissArea({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  if (Platform.OS === 'web') {
    return <View style={style}>{children}</View>;
  }
  return (
    <Pressable accessible={false} onPress={() => Keyboard.dismiss()} style={style}>
      {children}
    </Pressable>
  );
}
