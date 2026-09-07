import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionModal } from '@/components/ui/action-modal';
import type { PinnedMessage } from '@/data/repositories/contracts';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

export interface PinnedGroup {
  conversationId: string;
  title: string;
  pins: PinnedMessage[];
}

/**
 * Pins arrive newest first across every chat. Grouping keeps that order: a
 * chat appears where its newest pin fell, and its own pins stay in order
 * inside it, so the list never reshuffles between two loads.
 */
export function groupPinsByConversation(
  pins: PinnedMessage[],
  titleFor: (conversationId: string) => string | null | undefined,
): PinnedGroup[] {
  const groups: PinnedGroup[] = [];
  const byId = new Map<string, PinnedGroup>();
  for (const pin of pins) {
    const title = titleFor(pin.conversationId);
    // A pin in a chat the device does not know about has nowhere to go.
    if (!title) continue;
    const existing = byId.get(pin.conversationId);
    if (existing) {
      existing.pins.push(pin);
      continue;
    }
    const group = { conversationId: pin.conversationId, title, pins: [pin] };
    byId.set(pin.conversationId, group);
    groups.push(group);
  }
  return groups;
}

/** What a pinned row says: the words, or one word for what was sent. */
export function pinnedPreview(pin: PinnedMessage, t: (key: MessageKey) => string): string {
  const text = pin.text.trim();
  if (text) return text;
  if (pin.attachmentKind === 'image') return t('chat.attachmentPhoto');
  if (pin.attachmentKind === 'video') return t('chat.attachmentVideo');
  if (pin.attachmentKind === 'voice') return t('chat.attachmentVoice');
  if (pin.attachmentKind === 'file') return t('chat.attachmentFile');
  return '';
}

export function pinnedTimeLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(date);
}

function PinnedRow({
  pin,
  onOpen,
  onUnpin,
  busy,
}: {
  pin: PinnedMessage;
  onOpen: () => void;
  onUnpin: () => void;
  busy: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { locale, t } = useI18n();
  const preview = pinnedPreview(pin, t);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={`${t('chat.pinnedGoTo')}: ${pin.senderName} ${preview}`}
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => [styles.rowBody, pressed && styles.rowBodyActive]}>
        <Text numberOfLines={1} style={styles.rowMeta}>
          {`${pin.senderName} · ${pinnedTimeLabel(pin.sentAt, locale)}`}
        </Text>
        <Text numberOfLines={2} style={styles.rowText}>{preview}</Text>
      </Pressable>
      {pin.canUnpin ? (
        <Pressable
          accessibilityLabel={`${t('chat.unpin')}: ${pin.senderName}`}
          accessibilityRole="button"
          disabled={busy}
          hitSlop={8}
          onPress={onUnpin}
          style={({ pressed }) => [styles.unpin, pressed && styles.unpinActive]}>
          <Ionicons color={colors.inkMuted} name="close" size={16} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The pins of one chat, or of every chat when no chat is named. Tapping a row
 * closes the sheet and hands the message back to whoever opened it, which is
 * the same jump the reply quotes use.
 */
export function PinnedMessagesModal({
  visible,
  conversationId,
  onClose,
  onOpenMessage,
}: {
  visible: boolean;
  conversationId?: string | null;
  onClose: () => void;
  onOpenMessage: (conversationId: string, messageId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const loadPinnedMessages = workspace.loadPinnedMessages;
  const unpinMessage = workspace.unpinMessage;
  const [pins, setPins] = useState<PinnedMessage[] | null>(null);
  const [unpinning, setUnpinning] = useState<string | null>(null);
  const everyChat = !conversationId;

  // Mounted for one opening: the list loads once and nothing has to be reset
  // on the way in, so the sheet never shows the previous chat's pins.
  useEffect(() => {
    let live = true;
    void loadPinnedMessages(conversationId ?? null).then((loaded) => {
      if (live) setPins(loaded ?? []);
    });
    return () => {
      live = false;
    };
  }, [conversationId, loadPinnedMessages]);

  const titleFor = useCallback(
    (id: string) => workspace.conversations.find((item) => item.id === id)?.title,
    [workspace.conversations],
  );
  const groups = pins && everyChat ? groupPinsByConversation(pins, titleFor) : [];
  const open = (pin: PinnedMessage) => {
    onClose();
    onOpenMessage(pin.conversationId, pin.messageId);
  };
  const unpin = async (pin: PinnedMessage) => {
    setUnpinning(pin.messageId);
    const removed = await unpinMessage(pin.conversationId, pin.messageId);
    setUnpinning(null);
    if (removed) {
      setPins((current) => (current ?? []).filter((item) => item.messageId !== pin.messageId));
    }
  };

  return (
    <ActionModal
      onClose={onClose}
      title={t(everyChat ? 'chat.pinnedAllTitle' : 'chat.pinnedTitle')}
      visible={visible}>
      {pins === null ? (
        <ActivityIndicator accessibilityLabel={t('chat.pinnedTitle')} color={colors.mintDark} />
      ) : pins.length === 0 ? (
        <Text style={styles.empty}>
          {t(everyChat ? 'chat.pinnedEmptyAll' : 'chat.pinnedEmpty')}
        </Text>
      ) : (
        <View style={styles.list}>
          {everyChat
            ? groups.map((group) => (
              <View key={group.conversationId} style={styles.group}>
                <Text style={styles.groupTitle}>{group.title}</Text>
                {group.pins.map((pin) => (
                  <PinnedRow
                    busy={unpinning === pin.messageId}
                    key={pin.messageId}
                    onOpen={() => open(pin)}
                    onUnpin={() => void unpin(pin)}
                    pin={pin}
                  />
                ))}
              </View>
            ))
            : pins.map((pin) => (
              <PinnedRow
                busy={unpinning === pin.messageId}
                key={pin.messageId}
                onOpen={() => open(pin)}
                onUnpin={() => void unpin(pin)}
                pin={pin}
              />
            ))}
        </View>
      )}
    </ActionModal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  list: { gap: 2 },
  group: { gap: 2, marginBottom: spacing.xs },
  groupTitle: {
    color: colors.inkSubtle,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowBody: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 7,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.sm,
  },
  rowBodyActive: { backgroundColor: colors.paperMuted },
  rowMeta: { color: colors.inkSubtle, fontSize: 10 },
  rowText: { color: colors.ink, fontSize: 13, marginTop: 1 },
  unpin: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  unpinActive: { backgroundColor: colors.paperMuted },
  empty: { color: colors.inkSubtle, fontSize: 12, paddingVertical: spacing.sm },
});
