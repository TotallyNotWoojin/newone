import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { VisibleMessageOutboxItem } from '@/data/persistence/types';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';

export interface MessageOutboxCopy {
  title: string;
  description: string;
  emptyTitle: string;
  emptyBody: string;
  queued: string;
  sending: string;
  failed: string;
  attempts: string;
  created: string;
  unknownConversation: string;
  edit: string;
  retry: string;
  cancel: string;
  editTitle: string;
  editDescription: string;
  message: string;
  save: string;
  cancelTitle: string;
  cancelDescription: string;
  cancelAmbiguousDescription: string;
  cancelConfirm: string;
  ambiguous: string;
  errorCode: string;
}

interface MessageOutboxSectionProps {
  items: VisibleMessageOutboxItem[];
  copy: MessageOutboxCopy;
  actionBusy: string | null;
  actionError: string | null;
  resolveConversationTitle: (conversationId: string) => string | null;
  onEdit: (outboxId: string, body: string) => Promise<boolean>;
  onRetry: (outboxId: string) => Promise<boolean>;
  onCancel: (outboxId: string) => Promise<boolean>;
  onClearError: () => void;
}

export function MessageOutboxSection({
  items,
  copy,
  actionBusy,
  actionError,
  resolveConversationTitle,
  onEdit,
  onRetry,
  onCancel,
  onClearError,
}: MessageOutboxSectionProps) {
  const [editing, setEditing] = useState<VisibleMessageOutboxItem | null>(null);
  const [editBody, setEditBody] = useState('');
  const [cancelling, setCancelling] = useState<VisibleMessageOutboxItem | null>(null);
  const sortedItems = useMemo(
    () => [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [items],
  );

  const closeEdit = () => {
    setEditing(null);
    setEditBody('');
    onClearError();
  };

  const closeCancel = () => {
    setCancelling(null);
    onClearError();
  };

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="cloud-upload-outline" size={19} color={colors.mintDark} />
        </View>
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
        {sortedItems.length ? (
          <StatusBadge
            label={String(sortedItems.length)}
            tone={sortedItems.some((item) => item.state === 'failed') ? 'danger' : 'warning'}
          />
        ) : null}
      </View>

      <View style={styles.content}>
        {!sortedItems.length ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={22} color={colors.mintDark} />
            <View style={styles.emptyCopy}>
              <Text style={styles.emptyTitle}>{copy.emptyTitle}</Text>
              <Text style={styles.emptyBody}>{copy.emptyBody}</Text>
            </View>
          </View>
        ) : sortedItems.map((item) => {
          const status = {
            queued: { label: copy.queued, tone: 'warning' as const },
            sending: { label: copy.sending, tone: 'info' as const },
            failed: { label: copy.failed, tone: 'danger' as const },
          }[item.state];
          const conversation = resolveConversationTitle(item.conversationId) ?? copy.unknownConversation;
          return (
            <View key={item.id} style={styles.item}>
              <View style={styles.itemTopline}>
                <Text numberOfLines={1} style={styles.conversation}>{conversation}</Text>
                <StatusBadge label={status.label} tone={status.tone} />
              </View>
              <Text selectable style={styles.body}>{item.body}</Text>
              <View style={styles.metadata}>
                <Text style={styles.metadataText}>
                  {copy.created} {new Date(item.createdAt).toLocaleString()}
                </Text>
                <Text style={styles.metadataText}>{copy.attempts} {item.attempts}</Text>
              </View>
              {item.lastErrorCode ? (
                <Text accessibilityLiveRegion="polite" selectable style={styles.errorCode}>
                  {copy.errorCode}: {item.lastErrorCode}
                </Text>
              ) : null}
              {item.deliveryAmbiguous ? (
                <View style={styles.warning}>
                  <Ionicons name="warning-outline" size={15} color={colors.amber} />
                  <Text style={styles.warningText}>{copy.ambiguous}</Text>
                </View>
              ) : null}
              <View style={styles.actions}>
                {item.canEdit ? (
                  <PrimaryButton
                    icon="create-outline"
                    label={copy.edit}
                    onPress={() => {
                      onClearError();
                      setEditing(item);
                      setEditBody(item.body);
                    }}
                    tone="light"
                  />
                ) : null}
                {item.canRetry ? (
                  <PrimaryButton
                    icon="refresh-outline"
                    label={copy.retry}
                    loading={actionBusy === `outbox-retry:${item.id}`}
                    onPress={() => void onRetry(item.id)}
                    tone="dark"
                  />
                ) : null}
                <PrimaryButton
                  icon="close-circle-outline"
                  label={copy.cancel}
                  loading={actionBusy === `outbox-cancel:${item.id}`}
                  onPress={() => {
                    onClearError();
                    setCancelling(item);
                  }}
                  tone="danger"
                />
              </View>
            </View>
          );
        })}
        <ActionError message={!editing && !cancelling ? actionError : null} />
      </View>

      <ActionModal
        description={copy.editDescription}
        onClose={closeEdit}
        title={copy.editTitle}
        visible={Boolean(editing)}>
        <FormField label={copy.message} multiline onChangeText={setEditBody} value={editBody} />
        <ActionError message={actionError} />
        <PrimaryButton
          disabled={!editBody.trim() || editBody.trim().length > 12_000}
          icon="checkmark"
          label={copy.save}
          loading={editing ? actionBusy === `outbox-edit:${editing.id}` : false}
          onPress={async () => {
            if (editing && await onEdit(editing.id, editBody)) closeEdit();
          }}
          tone="dark"
        />
      </ActionModal>

      <ActionModal
        description={cancelling?.deliveryAmbiguous
          ? copy.cancelAmbiguousDescription
          : copy.cancelDescription}
        onClose={closeCancel}
        title={copy.cancelTitle}
        visible={Boolean(cancelling)}>
        {cancelling?.deliveryAmbiguous ? (
          <View style={styles.warning}>
            <Ionicons name="warning-outline" size={17} color={colors.amber} />
            <Text style={styles.warningText}>{copy.ambiguous}</Text>
          </View>
        ) : null}
        <ActionError message={actionError} />
        <PrimaryButton
          icon="close-circle-outline"
          label={copy.cancelConfirm}
          loading={cancelling ? actionBusy === `outbox-cancel:${cancelling.id}` : false}
          onPress={async () => {
            if (cancelling && await onCancel(cancelling.id)) closeCancel();
          }}
          tone="danger"
        />
      </ActionModal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    overflow: 'hidden',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.paperMuted,
  },
  headerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 14, fontWeight: '900' },
  description: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: 3 },
  content: { gap: spacing.sm, padding: spacing.md },
  empty: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  emptyCopy: { flex: 1, minWidth: 0 },
  emptyTitle: { color: colors.forest, fontSize: 12, fontWeight: '900' },
  emptyBody: { color: colors.inkMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  item: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  itemTopline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  conversation: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 12, fontWeight: '900' },
  body: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  metadata: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metadataText: { color: colors.inkSubtle, fontSize: 9 },
  errorCode: { color: colors.red, fontFamily: type.mono, fontSize: 9 },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  warningText: { flex: 1, color: colors.amber, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
});
