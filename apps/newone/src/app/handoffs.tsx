import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  AppScaffold,
  DesktopPageHeader,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import { WorkplaceOnlyRoute } from '@/components/navigation/workplace-only-route';
import { IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import type { ShiftHandoff } from '@/domain/types';
import { handoffCorrectionCopy } from '@/features/handoffs/handoff-correction-copy';
import { handoffAcknowledgementCopy } from '@/features/handoffs/handoff-acknowledgement-copy';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useI18n } from '@/i18n/provider';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';
import { a11yState } from '@/lib/a11y-state';

function HandoffsWorkplaceScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const copy = handoffCorrectionCopy(locale);
  const acknowledgementCopy = handoffAcknowledgementCopy(locale);
  const { handoffs } = workspace;
  const canCreate = workspace.hasCapability('handoff.manage');
  const shiftConversations = workspace.conversations.filter((conversation) => (
    conversation.kind === 'shift' && !conversation.managementOnly
  ));
  const [showCreate, setShowCreate] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [shiftStartedAt, setShiftStartedAt] = useState(() => new Date().toISOString());
  const [shiftEndedAt, setShiftEndedAt] = useState(() => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString());
  const [acknowledgementDueAt, setAcknowledgementDueAt] = useState(() => new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString());
  const [sourceMessageIds, setSourceMessageIds] = useState<string[]>([]);
  const [correctionTarget, setCorrectionTarget] = useState<ShiftHandoff | null>(null);
  const [correctionTitle, setCorrectionTitle] = useState('');
  const [correctionDetails, setCorrectionDetails] = useState('');
  const [correctionShiftStartedAt, setCorrectionShiftStartedAt] = useState('');
  const [correctionShiftEndedAt, setCorrectionShiftEndedAt] = useState('');
  const [correctionAcknowledgementDueAt, setCorrectionAcknowledgementDueAt] = useState('');
  const [correctionSourceMessageIds, setCorrectionSourceMessageIds] = useState<string[]>([]);
  const [correctionReason, setCorrectionReason] = useState('');
  const [acknowledgementTarget, setAcknowledgementTarget] = useState<ShiftHandoff | null>(null);
  const [acknowledgementNote, setAcknowledgementNote] = useState('');
  const [localTime] = useState(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const selectableMessages = (workspace.messages[conversationId] ?? []).filter(
    (message) => !message.deleted && Boolean(message.serverId ?? message.id),
  );
  const correctionMessages = correctionTarget
    ? (workspace.messages[correctionTarget.conversationId] ?? []).filter(
        (message) => !message.deleted && Boolean(message.serverId ?? message.id),
      )
    : [];
  const correctionMessageById = new Map(
    correctionMessages.map((message) => [message.serverId ?? message.id, message]),
  );
  const correctionCandidateIds = correctionTarget
    ? [...new Set([
        ...correctionTarget.sourceMessageIds,
        ...correctionMessages.slice(-30).map((message) => message.serverId ?? message.id),
      ])]
    : [];
  const correctionStart = Date.parse(correctionShiftStartedAt);
  const correctionEnd = Date.parse(correctionShiftEndedAt);
  const correctionDue = correctionAcknowledgementDueAt.trim()
    ? Date.parse(correctionAcknowledgementDueAt)
    : null;
  const correctionValid = Boolean(
    correctionTarget
    && correctionTitle.trim().length >= 1
    && correctionTitle.trim().length <= 240
    && correctionDetails.trim().length >= 1
    && correctionDetails.trim().length <= 30_000
    && correctionReason.trim().length >= 3
    && correctionReason.trim().length <= 2_000
    && Number.isFinite(correctionStart)
    && Number.isFinite(correctionEnd)
    && correctionEnd > correctionStart
    && correctionSourceMessageIds.length >= 1
    && correctionSourceMessageIds.length <= 500
    && (correctionDue === null || (Number.isFinite(correctionDue) && correctionDue > correctionEnd))
  );
  const openCreate = () => {
    workspace.clearActionError();
    setConversationId(shiftConversations[0]?.id ?? '');
    setTitle('');
    setDetails('');
    setSourceMessageIds([]);
    setAcknowledgementDueAt(new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString());
    setShowCreate(true);
  };

  const toggleSource = (messageId: string) => {
    setSourceMessageIds((current) => current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]);
  };

  const openCorrection = (handoff: ShiftHandoff) => {
    workspace.clearActionError();
    setCorrectionTarget(handoff);
    setCorrectionTitle(handoff.title);
    setCorrectionDetails(handoff.summary);
    setCorrectionShiftStartedAt(handoff.shiftStartedAt);
    setCorrectionShiftEndedAt(handoff.shiftEndedAt);
    setCorrectionAcknowledgementDueAt(handoff.acknowledgementDueAt ?? '');
    setCorrectionSourceMessageIds([...handoff.sourceMessageIds]);
    setCorrectionReason('');
  };

  const toggleCorrectionSource = (messageId: string) => {
    setCorrectionSourceMessageIds((current) => current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]);
  };

  const openAcknowledgement = (handoff: ShiftHandoff) => {
    workspace.clearActionError();
    setAcknowledgementTarget(handoff);
    setAcknowledgementNote('');
  };

  return (
    <AppScaffold
      current="handoffs"
      mobileHeader={
        <MobileBrandHeader
          right={canCreate && shiftConversations.length ? <IconButton label={t('handoffs.create')} name="add" onPress={openCreate} size={38} tone="accent" /> : undefined}
          subtitle={`${handoffs.filter((handoff) => handoff.canSign || handoff.canAcknowledge).length} ${t('handoffs.actionRequiredSuffix')}`}
          title={t('handoffs.title')}
        />
      }>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error' ? (
        <WorkspaceStatePanel resource="handoffs" />
      ) : (
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        showsVerticalScrollIndicator={false}>
        {desktop ? (
          <DesktopPageHeader
            actions={canCreate && shiftConversations.length ? <PrimaryButton icon="add" label={t('handoffs.start')} onPress={openCreate} /> : undefined}
            description={t('handoffs.description')}
            eyebrow={t('handoffs.eyebrow')}
            title={t('handoffs.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
          <View style={styles.workflowBanner}>
            <View style={styles.workflowIcon}>
              <Ionicons name="sparkles" size={20} color={colors.plum} />
            </View>
            <View style={styles.workflowCopy}>
              <Text style={styles.workflowTitle}>{t('handoffs.workflowTitle')}</Text>
              <Text style={styles.workflowText}>
                {t('handoffs.workflowBody')}
              </Text>
            </View>
            {desktop ? <StatusBadge label={t('handoffs.humanSignoff')} tone="purple" /> : null}
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionEyebrow}>{t('handoffs.currentWindow')}</Text>
              <Text style={styles.sectionTitle}>{t('handoffs.today')}</Text>
            </View>
            <Text style={styles.localTime}>{localTime}</Text>
          </View>

          <View style={styles.cardGrid}>
            {handoffs.map((handoff) => (
              <HandoffCard
                busy={workspace.actionBusy}
                canCorrect={canCreate && workspace.conversations.find(
                  (conversation) => conversation.id === handoff.conversationId,
                )?.canManage === true}
                handoff={handoff}
                key={handoff.id}
                sourceMessages={(workspace.messages[handoff.conversationId] ?? []).filter((message) =>
                  handoff.sourceMessageIds.includes(message.serverId ?? message.id))}
                onAcknowledge={() => openAcknowledgement(handoff)}
                onCorrect={() => openCorrection(handoff)}
                onOpenSource={(messageId) => {
                  workspace.selectConversation(handoff.conversationId);
                  router.push({
                    pathname: '/conversation/[id]',
                    params: { id: handoff.conversationId, messageId },
                  });
                }}
                onSign={() => void workspace.signHandoff(handoff.id)}
              />
            ))}
            {canCreate && shiftConversations.length ? <View style={[styles.emptyCard, shadow]}>
              <View style={styles.emptyIcon}>
                <Ionicons name="add" size={22} color={colors.mintDark} />
              </View>
              <Text style={styles.emptyTitle}>{t('handoffs.startAnother')}</Text>
              <Text style={styles.emptyText}>
                {t('handoffs.startAnotherBody')}
              </Text>
              <PrimaryButton label={t('handoffs.create')} onPress={openCreate} tone="light" />
            </View> : null}
            {!handoffs.length && !(canCreate && shiftConversations.length) ? (
              <View style={[styles.emptyCard, shadow]}>
                <Ionicons name="swap-horizontal-outline" size={24} color={colors.mintDark} />
                <Text style={styles.emptyTitle}>{t('handoffs.noneAssigned')}</Text>
                <Text style={styles.emptyText}>{t('handoffs.noneAssignedBody')}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
      )}
      <ActionModal
        description={t('handoffs.createDescription')}
        onClose={() => setShowCreate(false)}
        title={t('handoffs.createTitle')}
        visible={showCreate}>
        <View style={styles.channelChoices}>
          {shiftConversations.map((conversation) => (
            <PrimaryButton
              key={conversation.id}
              label={conversation.title}
              onPress={() => {
                setConversationId(conversation.id);
                setSourceMessageIds([]);
              }}
              tone={conversationId === conversation.id ? 'dark' : 'light'}
            />
          ))}
        </View>
        <FormField label={t('handoffs.fieldTitle')} onChangeText={setTitle} value={title} />
        <FormField label={t('handoffs.details')} multiline onChangeText={setDetails} value={details} />
        <FormField label={t('handoffs.shiftStarted')} onChangeText={setShiftStartedAt} value={shiftStartedAt} />
        <FormField label={t('handoffs.shiftEnded')} onChangeText={setShiftEndedAt} value={shiftEndedAt} />
        <FormField label={t('handoffs.acknowledgementDue')} onChangeText={setAcknowledgementDueAt} value={acknowledgementDueAt} />
        <View style={styles.sourceSection}>
          <View style={styles.sourceHeader}>
            <Text style={styles.sourceTitle}>{t('handoffs.sourceMessages')}</Text>
            <StatusBadge label={`${sourceMessageIds.length} ${t('handoffs.selected')}`} tone={sourceMessageIds.length ? 'success' : 'warning'} />
          </View>
          <Text style={styles.sourceHint}>{t('handoffs.sourceMessagesHint')}</Text>
          {selectableMessages.length ? (
            <View style={styles.sourcePicker}>
              {selectableMessages.slice(-30).map((message) => {
                const messageId = message.serverId ?? message.id;
                const selected = sourceMessageIds.includes(messageId);
                return (
                  <Pressable
                    accessibilityRole="checkbox"
                    {...a11yState({ checked: selected })}
                    key={messageId}
                    onPress={() => toggleSource(messageId)}
                    style={[styles.sourceRow, selected && styles.sourceRowSelected]}>
                    <View style={[styles.sourceCheck, selected && styles.sourceCheckSelected]}>
                      {selected ? <Ionicons name="checkmark" size={14} color={colors.onAccent} /> : null}
                    </View>
                    <View style={styles.sourceCopy}>
                      <Text style={styles.sourceSender}>{message.senderName} · {message.sentAt}</Text>
                      <Text numberOfLines={2} style={styles.sourceExcerpt}>{message.originalText || t('handoffs.attachmentSource')}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.sourceEmpty}>{t('handoffs.noSourceMessages')}</Text>
          )}
        </View>
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!conversationId || !title.trim() || !details.trim() || sourceMessageIds.length < 1}
          label={t('handoffs.createDraft')}
          loading={workspace.actionBusy === 'handoff-create'}
          onPress={async () => {
            if (await workspace.createHandoff({
              conversationId,
              title,
              details,
              shiftStartedAt,
              shiftEndedAt,
              sourceMessageIds,
              acknowledgementDueAt: acknowledgementDueAt.trim() || null,
            })) {
              setShowCreate(false);
            }
          }}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={acknowledgementCopy.description}
        onClose={() => setAcknowledgementTarget(null)}
        title={acknowledgementCopy.title}
        visible={acknowledgementTarget !== null}>
        {acknowledgementTarget ? (
          <>
            <View style={styles.correctionVersionPanel}>
              <View style={styles.correctionVersionColumn}>
                <Text style={styles.correctionMetaLabel}>{acknowledgementCopy.exactVersion}</Text>
                <Text style={styles.correctionVersionValue}>
                  {acknowledgementCopy.version} {acknowledgementTarget.versionNumber}
                </Text>
                <Text selectable style={styles.correctionVersionId}>
                  {acknowledgementTarget.versionId}
                </Text>
              </View>
            </View>
            <FormField
              label={acknowledgementCopy.discrepancyNote}
              multiline
              onChangeText={setAcknowledgementNote}
              placeholder={acknowledgementCopy.discrepancyPlaceholder}
              value={acknowledgementNote}
            />
            <Text style={styles.correctionFieldHint}>{acknowledgementCopy.discrepancyHint}</Text>
            {acknowledgementNote.trim().length > 2_000 ? (
              <Text style={styles.correctionValidation}>{acknowledgementCopy.tooLong}</Text>
            ) : null}
            <ActionError message={workspace.actionError} />
            <PrimaryButton
              disabled={acknowledgementNote.trim().length > 2_000}
              icon="hand-left-outline"
              label={acknowledgementCopy.confirm}
              loading={workspace.actionBusy === `handoff-acknowledge:${acknowledgementTarget.id}`}
              onPress={async () => {
                if (await workspace.acknowledgeHandoff(acknowledgementTarget.id, {
                  expectedVersionId: acknowledgementTarget.versionId,
                  expectedVersionNumber: acknowledgementTarget.versionNumber,
                  note: acknowledgementNote,
                })) {
                  setAcknowledgementTarget(null);
                }
              }}
              tone="dark"
            />
          </>
        ) : null}
      </ActionModal>
      <ActionModal
        description={copy.correctionDescription}
        onClose={() => setCorrectionTarget(null)}
        title={copy.correctionTitle}
        visible={correctionTarget !== null}>
        {correctionTarget ? (
          <>
            <View style={styles.correctionVersionPanel}>
              <View style={styles.correctionVersionColumn}>
                <Text style={styles.correctionMetaLabel}>{copy.exactVersion}</Text>
                <Text style={styles.correctionVersionValue}>
                  {copy.version} {correctionTarget.versionNumber}
                </Text>
                <Text selectable style={styles.correctionVersionId}>
                  {correctionTarget.versionId}
                </Text>
              </View>
              <Ionicons name="arrow-forward" color={colors.mintDark} size={20} />
              <View style={[styles.correctionVersionColumn, styles.correctionVersionColumnRight]}>
                <Text style={styles.correctionMetaLabel}>{copy.createsVersion}</Text>
                <Text style={styles.correctionVersionValue}>
                  {copy.version} {correctionTarget.versionNumber + 1}
                </Text>
                <StatusBadge label={copy.signatureReset} tone="warning" />
              </View>
            </View>
            <FormField
              label={t('handoffs.fieldTitle')}
              onChangeText={setCorrectionTitle}
              value={correctionTitle}
            />
            <FormField
              label={t('handoffs.details')}
              multiline
              onChangeText={setCorrectionDetails}
              value={correctionDetails}
            />
            <FormField
              label={t('handoffs.shiftStarted')}
              onChangeText={setCorrectionShiftStartedAt}
              value={correctionShiftStartedAt}
            />
            <FormField
              label={t('handoffs.shiftEnded')}
              onChangeText={setCorrectionShiftEndedAt}
              value={correctionShiftEndedAt}
            />
            <FormField
              label={copy.deadline}
              onChangeText={setCorrectionAcknowledgementDueAt}
              value={correctionAcknowledgementDueAt}
            />
            {!correctionAcknowledgementDueAt.trim() ? (
              <Text style={styles.correctionFieldHint}>{copy.noDeadline}</Text>
            ) : null}
            <View style={styles.sourceSection}>
              <View style={styles.sourceHeader}>
                <Text style={styles.sourceTitle}>{copy.exactSources}</Text>
                <StatusBadge
                  label={`${correctionSourceMessageIds.length} ${t('handoffs.selected')}`}
                  tone={correctionSourceMessageIds.length ? 'success' : 'warning'}
                />
              </View>
              <Text style={styles.sourceHint}>{copy.exactSourcesHint}</Text>
              <View style={styles.correctionSourcePicker}>
                {correctionCandidateIds.map((messageId) => {
                  const message = correctionMessageById.get(messageId);
                  const selected = correctionSourceMessageIds.includes(messageId);
                  return (
                    <Pressable
                      accessibilityLabel={`${copy.sourceId} ${messageId}`}
                      accessibilityRole="checkbox"
                      {...a11yState({ checked: selected })}
                      key={messageId}
                      onPress={() => toggleCorrectionSource(messageId)}
                      style={[styles.sourceRow, selected && styles.sourceRowSelected]}>
                      <View style={[styles.sourceCheck, selected && styles.sourceCheckSelected]}>
                        {selected ? <Ionicons name="checkmark" size={14} color={colors.onAccent} /> : null}
                      </View>
                      <View style={styles.sourceCopy}>
                        <Text style={styles.sourceSender}>
                          {message ? `${message.senderName} · ${message.sentAt}` : `${copy.sourceId} ${messageId}`}
                        </Text>
                        <Text numberOfLines={2} selectable style={styles.sourceExcerpt}>
                          {message?.originalText || messageId}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <FormField
              label={copy.reason}
              multiline
              onChangeText={setCorrectionReason}
              placeholder={copy.reasonPlaceholder}
              value={correctionReason}
            />
            <Text style={styles.correctionFieldHint}>{copy.reasonHint}</Text>
            {!correctionValid ? <Text style={styles.correctionValidation}>{copy.invalid}</Text> : null}
            <ActionError message={workspace.actionError} />
            <PrimaryButton
              disabled={!correctionValid}
              icon="create-outline"
              label={copy.publish}
              loading={workspace.actionBusy === `handoff-correct:${correctionTarget.id}`}
              onPress={async () => {
                if (await workspace.correctHandoff(correctionTarget.id, {
                  expectedVersionId: correctionTarget.versionId,
                  expectedVersionNumber: correctionTarget.versionNumber,
                  title: correctionTitle,
                  details: correctionDetails,
                  shiftStartedAt: correctionShiftStartedAt,
                  shiftEndedAt: correctionShiftEndedAt,
                  sourceMessageIds: correctionSourceMessageIds,
                  acknowledgementDueAt: correctionAcknowledgementDueAt.trim() || null,
                  reason: correctionReason,
                })) {
                  setCorrectionTarget(null);
                }
              }}
              tone="dark"
            />
          </>
        ) : null}
      </ActionModal>
    </AppScaffold>
  );
}

function HandoffCard({
  handoff,
  busy,
  canCorrect,
  onSign,
  onAcknowledge,
  onCorrect,
  onOpenSource,
  sourceMessages,
}: {
  handoff: ShiftHandoff;
  sourceMessages: { id: string; serverId?: string; senderName: string; sentAt: string; originalText: string }[];
  busy: string | null;
  canCorrect: boolean;
  onSign: () => void;
  onAcknowledge: () => void;
  onCorrect: () => void;
  onOpenSource: (messageId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { locale, t } = useI18n();
  const copy = handoffCorrectionCopy(locale);
  const status = {
    draft: { label: t('handoffs.statusDraft'), tone: 'neutral' as const },
    awaiting_signoff: { label: t('handoffs.statusWaiting'), tone: 'warning' as const },
    ready: { label: t('handoffs.statusReady'), tone: 'info' as const },
    acknowledged: { label: t('handoffs.statusAcknowledged'), tone: 'success' as const },
  }[handoff.status];
  return (
    <View style={[styles.card, shadow]}>
      <View style={styles.cardTopline}>
        <StatusBadge icon="swap-horizontal" label={status.label} tone={status.tone} />
        <View style={styles.cardVersionStack}>
          <Text style={styles.cardVersion}>{copy.version} {handoff.versionNumber}</Text>
          <Text style={styles.cardWindow}>{handoff.window}</Text>
        </View>
      </View>
      <Text style={styles.cardTitle}>{handoff.title}</Text>
      <Text style={styles.cardSite}>{handoff.site}</Text>

      <View style={styles.shiftFlow}>
        <View style={styles.shiftNode}>
          <Text style={styles.shiftNodeLabel}>{t('handoffs.outgoing')}</Text>
          <Text style={styles.shiftNodeValue}>{handoff.outgoingShift}</Text>
          <Text style={styles.shiftSupervisor}>{handoff.outgoingSupervisor}</Text>
        </View>
        <View style={styles.shiftArrow}>
          <View style={styles.shiftLine} />
          <View style={styles.shiftArrowIcon}>
            <Ionicons name="arrow-forward" size={15} color={colors.mintDark} />
          </View>
          <View style={styles.shiftLine} />
        </View>
        <View style={[styles.shiftNode, styles.shiftNodeRight]}>
          <Text style={styles.shiftNodeLabel}>{t('handoffs.incoming')}</Text>
          <Text style={styles.shiftNodeValue}>{handoff.incomingShift}</Text>
          <Text style={styles.shiftSupervisor}>{handoff.incomingSupervisor}</Text>
        </View>
      </View>

      <View style={styles.summaryBox}>
        <Text style={styles.summaryLabel}>{t('handoffs.draftSummary')}</Text>
        <Text style={styles.summaryText}>{handoff.summary}</Text>
      </View>

      {handoff.correctionReason ? (
        <View style={styles.correctionHistory}>
          <Text style={styles.correctionMetaLabel}>
            {copy.correctedFrom} {copy.version} {Math.max(1, handoff.versionNumber - 1)} · {copy.signatureReset}
          </Text>
          <Text style={styles.correctionHistoryReason}>{handoff.correctionReason}</Text>
        </View>
      ) : null}

      <View style={styles.linkedSources}>
        <View style={styles.sourceHeader}>
          <Text style={styles.summaryLabel}>{t('handoffs.linkedSourceEvidence')}</Text>
          {handoff.sourceState === 'stale' ? <StatusBadge icon="warning-outline" label={t('handoffs.sourceStale')} tone="warning" /> : null}
        </View>
        {sourceMessages.slice(0, 3).map((message) => {
          const messageId = message.serverId ?? message.id;
          return (
            <Pressable
              accessibilityLabel={`${copy.openSource}: ${message.senderName}`}
              accessibilityRole="button"
              key={messageId}
              onPress={() => onOpenSource(messageId)}
              style={({ pressed }) => [styles.linkedSourceRow, styles.linkedSourceButton, pressed && styles.linkedSourcePressed]}>
              <Ionicons name="chatbubble-ellipses-outline" color={colors.mintDark} size={15} />
              <View style={styles.sourceCopy}>
                <Text style={styles.sourceSender}>{message.senderName} · {message.sentAt}</Text>
                <Text numberOfLines={2} style={styles.sourceExcerpt}>{message.originalText}</Text>
              </View>
              <Ionicons name="arrow-forward" color={colors.mintDark} size={15} />
            </Pressable>
          );
        })}
        {handoff.sourceMessageIds
          .filter((messageId) => !sourceMessages.some((message) => (message.serverId ?? message.id) === messageId))
          .slice(0, Math.max(0, 3 - sourceMessages.length))
          .map((messageId) => (
            <Pressable
              accessibilityLabel={`${copy.openSource}: ${messageId}`}
              accessibilityRole="button"
              key={messageId}
              onPress={() => onOpenSource(messageId)}
              style={({ pressed }) => [styles.linkedSourceRow, styles.linkedSourceButton, pressed && styles.linkedSourcePressed]}>
              <Ionicons name="link-outline" color={colors.mintDark} size={15} />
              <Text numberOfLines={1} style={[styles.sourceEmpty, styles.unloadedSourceId]}>{messageId}</Text>
              <Ionicons name="arrow-forward" color={colors.mintDark} size={15} />
            </Pressable>
          ))}
        {handoff.acknowledgementDueAt ? (
          <Text style={styles.ackDue}>{t('handoffs.acknowledgementDue')} · {new Date(handoff.acknowledgementDueAt).toLocaleString()}</Text>
        ) : null}
      </View>

      <View style={styles.cardStats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{handoff.openItems}</Text>
          <Text style={styles.statLabel}>{t('handoffs.openItem')}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{handoff.sourceCount}</Text>
          <Text style={styles.statLabel}>{t('handoffs.linkedSources')}</Text>
        </View>
        {canCorrect || handoff.canSign || handoff.canAcknowledge ? (
          <View style={styles.cardActions}>
            {canCorrect ? (
              <PrimaryButton
                icon="create-outline"
                label={copy.correct}
                loading={busy === `handoff-correct:${handoff.id}`}
                onPress={onCorrect}
                tone="light"
              />
            ) : null}
            {handoff.canSign ? (
            <PrimaryButton
              icon="create-outline"
              label={t('handoffs.sign')}
              loading={busy === 'handoff-sign'}
              onPress={onSign}
              tone="dark"
            />
            ) : handoff.canAcknowledge ? (
            <PrimaryButton
              icon="hand-left-outline"
              label={t('handoffs.acknowledge')}
              loading={busy === `handoff-acknowledge:${handoff.id}`}
              onPress={onAcknowledge}
              tone="dark"
            />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  page: {
    flexGrow: 1,
    paddingBottom: spacing.xxxl,
  },
  pageMobile: {
    padding: spacing.md,
    paddingBottom: 100,
  },
  content: {
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
  },
  contentDesktop: {
    paddingHorizontal: spacing.xxl,
  },
  sourceSection: { gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.line, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  sourceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  sourceTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  sourceHint: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
  sourcePicker: { gap: spacing.xs, maxHeight: 310 },
  correctionSourcePicker: { gap: spacing.xs },
  sourceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.paper },
  sourceRowSelected: { backgroundColor: colors.mintSoft },
  sourceCheck: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 7 },
  sourceCheckSelected: { backgroundColor: colors.mint, borderColor: colors.mint },
  sourceCopy: { flex: 1, minWidth: 0 },
  sourceSender: { color: colors.ink, fontSize: 10, fontWeight: '800' },
  sourceExcerpt: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  sourceEmpty: { color: colors.inkSubtle, fontSize: 10, fontStyle: 'italic' },
  correctionVersionPanel: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.mintSoft },
  correctionVersionColumn: { flex: 1, minWidth: 0, gap: 4 },
  correctionVersionColumnRight: { alignItems: 'flex-end' },
  correctionMetaLabel: { color: colors.plum, fontSize: 9, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  correctionVersionValue: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  correctionVersionId: { color: colors.inkSubtle, fontSize: 9 },
  correctionFieldHint: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: -spacing.sm },
  correctionValidation: { color: colors.amber, fontSize: 11, fontWeight: '700', lineHeight: 17 },
  correctionHistory: { gap: 5, marginTop: spacing.sm, padding: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.amber, backgroundColor: colors.amberSoft },
  correctionHistoryReason: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  linkedSources: { gap: spacing.xs, marginTop: spacing.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.line, borderRadius: radii.md },
  linkedSourceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  linkedSourceButton: { minHeight: 44, alignItems: 'center', paddingHorizontal: spacing.xs, borderRadius: radii.sm },
  linkedSourcePressed: { backgroundColor: colors.mintSoft },
  unloadedSourceId: { flex: 1, minWidth: 0 },
  ackDue: { color: colors.amber, fontSize: 10, fontWeight: '800', marginTop: spacing.xs },
  workflowBanner: {
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.plumSoft,
    borderWidth: 1,
    borderColor: colors.plumBorder,
  },
  workflowIcon: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  workflowCopy: {
    flex: 1,
    minWidth: 0,
  },
  workflowTitle: {
    color: colors.plumStrong,
    fontSize: 13,
    fontWeight: '900',
  },
  workflowText: {
    color: colors.plumMuted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 3,
  },
  sectionHeader: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  sectionEyebrow: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 21,
    fontWeight: '800',
    marginTop: 3,
  },
  localTime: {
    color: colors.inkSubtle,
    fontSize: 10,
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    alignItems: 'stretch',
  },
  card: {
    minWidth: 330,
    flexGrow: 1,
    flexBasis: 480,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardWindow: {
    color: colors.inkSubtle,
    fontSize: 10,
  },
  cardVersionStack: { alignItems: 'flex-end', gap: 2 },
  cardVersion: { color: colors.plum, fontSize: 9, fontWeight: '900', letterSpacing: 0.4, textTransform: 'uppercase' },
  cardTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.35,
    marginTop: spacing.md,
  },
  cardSite: {
    color: colors.inkSubtle,
    fontSize: 11,
    marginTop: 3,
  },
  shiftFlow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.lg,
  },
  shiftNode: {
    flex: 1,
  },
  shiftNodeRight: {
    alignItems: 'flex-end',
  },
  shiftNodeLabel: {
    color: colors.inkSubtle,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  shiftNodeValue: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    marginTop: 3,
  },
  shiftSupervisor: {
    color: colors.inkMuted,
    fontSize: 10,
    marginTop: 2,
  },
  shiftArrow: {
    width: 86,
    flexDirection: 'row',
    alignItems: 'center',
  },
  shiftLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.lineStrong,
  },
  shiftArrowIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.mintSoft,
  },
  summaryBox: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  summaryLabel: {
    color: colors.plum,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 5,
  },
  summaryText: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  cardStats: {
    minHeight: 58,
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  statLabel: {
    color: colors.inkSubtle,
    fontSize: 9,
    marginTop: 1,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: colors.line,
  },
  cardActions: {
    flexGrow: 1,
    flexBasis: 190,
    alignItems: 'stretch',
    gap: spacing.xs,
  },
  emptyCard: {
    minWidth: 280,
    flexGrow: 1,
    flexBasis: 300,
    minHeight: 280,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.lineStrong,
    backgroundColor: 'rgba(255,255,255,0.52)',
  },
  emptyIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.lg,
    backgroundColor: colors.mintSoft,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '900',
    marginTop: spacing.sm,
  },
  emptyText: {
    maxWidth: 300,
    color: colors.inkSubtle,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    marginVertical: spacing.sm,
  },
  channelChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
});

/** Workplace-only: a personal-realm account is sent back to Chats instead of
 *  being shown this screen. See components/navigation/workplace-only-route. */
export default function HandoffsScreen() {
  return <WorkplaceOnlyRoute screen={<HandoffsWorkplaceScreen />} />;
}
