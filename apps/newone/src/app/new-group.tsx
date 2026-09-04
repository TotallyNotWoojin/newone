import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionError, FormField } from '@/components/ui/action-modal';
import {
  Avatar,
  Chip,
  IconButton,
  PrimaryButton,
  SearchField,
  StatusBadge,
} from '@/components/ui/primitives';
import type {
  GroupCreationCandidate,
  InitialConversationRole,
} from '@/data/repositories/group-creation-dto.mjs';
import type { SelectedAttachment } from '@/data/attachments';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

type GroupKind = 'group' | 'team' | 'shift' | 'incident';
type PostingMode = 'all_members' | 'admins_only';
type JoinPolicy = 'inherit' | 'invite_only' | 'approval_required';

function candidateInitials(displayName: string): string {
  return displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function candidateColor(candidate: GroupCreationCandidate): string {
  if (candidate.membershipType === 'guest') return '#A55822';
  if (candidate.membershipType === 'contractor') return '#6553A3';
  return '#3478A9';
}

export default function NewGroupScreen() {
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const queryCandidates = workspace.queryGroupCreationCandidates;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<GroupKind>('group');
  const [unitId, setUnitId] = useState<string | null>(null);
  const [historyPolicy, setHistoryPolicy] = useState<'all' | 'since_join'>('since_join');
  const [postingMode, setPostingMode] = useState<PostingMode>('all_members');
  const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>('inherit');
  const [incidentSeverity, setIncidentSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('high');
  const [incidentClassification, setIncidentClassification] = useState('');
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<GroupCreationCandidate[]>([]);
  const [candidateCache, setCandidateCache] = useState<Record<string, GroupCreationCandidate>>({});
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, InitialConversationRole>>({});
  const [avatar, setAvatar] = useState<SelectedAttachment | null>(null);
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const [avatarUploadFailed, setAvatarUploadFailed] = useState(false);
  const requestSequence = useRef(0);
  const wide = width >= 920;
  const lockedInviteOnly = kind === 'shift' || kind === 'incident';
  // The personal realm is a consumer messenger: no workplace conversation
  // kinds, no owner/admin promotion at creation, and only accepted
  // connections (friends) can be added — the directory-style candidate
  // search is a workplace concept.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const friendIds = useMemo(
    () => new Set(
      workspace.people
        .filter((person) => person.connectionState === 'connected')
        .map((person) => person.id),
    ),
    [workspace.people],
  );
  const visibleCandidates = useMemo(
    () => personalRealm
      ? candidates.filter((candidate) => friendIds.has(candidate.userId))
      : candidates,
    [candidates, friendIds, personalRealm],
  );
  const groupKindOptions = useMemo(
    () => (personalRealm
      ? [['group', t('group.private')]]
      : [
          ['group', t('group.private')],
          ['team', t('group.team')],
          ['shift', t('group.shift')],
          ['incident', t('group.incident')],
        ]) as [GroupKind, string][],
    [personalRealm, t],
  );

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const timer = setTimeout(() => {
      setCandidatesLoading(true);
      void queryCandidates(search).then((result) => {
        if (requestSequence.current !== sequence) return;
        const next = result ?? [];
        setCandidates(next);
        setCandidateCache((current) => ({
          ...current,
          ...Object.fromEntries(next.map((candidate) => [candidate.userId, candidate])),
        }));
        setCandidatesLoading(false);
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [queryCandidates, search]);

  const selectedGuests = useMemo(
    () => Object.keys(selected)
      .map((userId) => candidateCache[userId])
      .filter((candidate): candidate is GroupCreationCandidate => candidate?.membershipType === 'guest'),
    [candidateCache, selected],
  );

  const selectKind = (nextKind: GroupKind) => {
    setKind(nextKind);
    if (nextKind === 'shift' || nextKind === 'incident') setJoinPolicy('invite_only');
  };

  const finish = (conversationId: string) => {
    if (width >= 920) router.replace('/');
    else router.replace({ pathname: '/conversation/[id]', params: { id: conversationId } });
  };

  const submit = async () => {
    const conversationId = createdConversationId ?? await workspace.createGroupConversation({
      name,
      description,
      kind,
      unitId,
      historyPolicy,
      postingMode,
      joinPolicy: lockedInviteOnly || personalRealm ? 'invite_only' : joinPolicy,
      incidentSeverity: kind === 'incident' ? incidentSeverity : undefined,
      incidentClassification: kind === 'incident' ? incidentClassification : undefined,
      members: Object.entries(selected).map(([membershipId, role]) => ({ membershipId, role })),
    });
    if (!conversationId) return;
    setCreatedConversationId(conversationId);
    if (avatar) {
      setAvatarUploadFailed(false);
      if (!await workspace.uploadConversationAvatar(conversationId, avatar)) {
        setAvatarUploadFailed(true);
        return;
      }
    }
    finish(conversationId);
  };

  const chooseAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.86,
    });
    const asset = result.assets?.[0];
    if (!asset) return;
    setAvatar({
      uri: asset.uri,
      name: asset.fileName ?? `group-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      imageMode: 'optimized',
    });
    setAvatarUploadFailed(false);
  };

  const toggle = (candidate: GroupCreationCandidate) => {
    setSelected((current) => {
      const next = { ...current };
      if (next[candidate.userId]) delete next[candidate.userId];
      else next[candidate.userId] = 'member';
      return next;
    });
  };

  const setRole = (candidate: GroupCreationCandidate, role: InitialConversationRole) => {
    if (candidate.membershipType === 'guest' && role !== 'member') return;
    setSelected((current) => ({ ...current, [candidate.userId]: role }));
  };

  const joinPolicyLabel = lockedInviteOnly || joinPolicy === 'invite_only'
    ? t('group.joinInviteOnly')
    : joinPolicy === 'approval_required'
      ? t('group.joinApproval')
      : t('group.joinInherit');

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <IconButton
          label={t('group.cancel')}
          name="close"
          onPress={() => createdConversationId ? finish(createdConversationId) : router.back()}
        />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={styles.headerTitle}>{t('group.title')}</Text>
          <Text numberOfLines={wide ? 2 : 1} style={styles.headerSubtitle}>{t('group.subtitle')}</Text>
        </View>
        <PrimaryButton
          disabled={
            !createdConversationId && (
              name.trim().length < 2 ||
              Object.keys(selected).length < 1 ||
              (kind === 'incident' && !incidentClassification.trim())
            )
          }
          label={createdConversationId
            ? avatar ? t('group.retryAvatarUpload') : t('group.continueWithoutAvatar')
            : t('group.create')}
          loading={workspace.actionBusy === 'create-group' || workspace.actionBusy === 'conversation-avatar-upload'}
          onPress={submit}
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View style={[styles.columns, wide && styles.columnsWide]}>
          <View style={styles.configurationColumn}>
            <View style={[styles.card, shadow]}>
              <View style={styles.cardHeading}>
                <Text style={styles.eyebrow}>{t('group.detailsEyebrow')}</Text>
                <Text style={styles.sectionTitle}>{t('group.detailsTitle')}</Text>
              </View>
              <FormField
                label={t('group.name')}
                onChangeText={setName}
                placeholder={t('group.namePlaceholder')}
                value={name}
              />
              <FormField
                label={t('group.description')}
                multiline
                onChangeText={setDescription}
                placeholder={t('group.descriptionPlaceholder')}
                value={description}
              />

              <View style={styles.avatarField}>
                <View style={styles.avatarCopy}>
                  <Text style={styles.label}>{t('group.avatarTitle')}</Text>
                  <Text style={styles.helperText}>{t('group.avatarDescription')}</Text>
                  <Text style={styles.avatarRequirements}>{t('group.avatarRequirements')}</Text>
                </View>
                {avatar ? (
                  <View style={styles.avatarSelection}>
                    <Image
                      accessibilityLabel={t('group.avatarSelected')}
                      resizeMode="cover"
                      source={{ uri: avatar.uri }}
                      style={styles.avatarPreview}
                    />
                    <View style={styles.avatarSelectionCopy}>
                      <Text numberOfLines={1} style={styles.avatarSelectedText}>
                        {t('group.avatarSelected')}
                      </Text>
                      <View style={styles.chips}>
                        <PrimaryButton
                          label={t('group.changeAvatar')}
                          onPress={() => void chooseAvatar()}
                          tone="light"
                        />
                        <PrimaryButton
                          label={t('group.removeAvatar')}
                          onPress={() => {
                            setAvatar(null);
                            setAvatarUploadFailed(false);
                          }}
                          tone="light"
                        />
                      </View>
                    </View>
                  </View>
                ) : (
                  <PrimaryButton
                    icon="image-outline"
                    label={t('group.chooseAvatar')}
                    onPress={() => void chooseAvatar()}
                    tone="light"
                  />
                )}
                {workspace.actionBusy === 'conversation-avatar-upload' ? (
                  <Text style={styles.avatarStatus}>{t(personalRealm ? 'group.avatarUploadingPlain' : 'group.avatarUploading')}</Text>
                ) : null}
                {avatarUploadFailed && createdConversationId ? (
                  <View style={styles.avatarRecovery}>
                    <Text style={styles.avatarRecoveryText}>{t('group.avatarUploadFailed')}</Text>
                    <View style={styles.chips}>
                      <PrimaryButton label={t('group.retryAvatarUpload')} onPress={() => void submit()} tone="dark" />
                      <PrimaryButton
                        label={t('group.continueWithoutAvatar')}
                        onPress={() => finish(createdConversationId)}
                        tone="light"
                      />
                    </View>
                  </View>
                ) : null}
              </View>

              {personalRealm ? null : (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('group.type')}</Text>
                <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
                  {groupKindOptions.map(([id, label]) => (
                    <Chip key={id} label={label} onPress={() => selectKind(id)} selected={kind === id} />
                  ))}
                </ScrollView>
              </View>
              )}

              {personalRealm ? null : (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('group.unitScope')}</Text>
                <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
                  <Chip
                    label={t('group.organizationWide')}
                    onPress={() => setUnitId(null)}
                    selected={unitId === null}
                  />
                  {workspace.units.map((unit) => (
                    <Chip
                      key={unit.unitId}
                      label={unit.name}
                      onPress={() => setUnitId(unit.unitId)}
                      selected={unitId === unit.unitId}
                    />
                  ))}
                </ScrollView>
                <Text style={styles.helperText}>{t('group.unitScopeDisclosure')}</Text>
              </View>
              )}

              <View style={styles.policyGrid}>
                <View style={styles.policyField}>
                  <Text style={styles.label}>{t('group.postingPolicy')}</Text>
                  <View style={styles.chips}>
                    <Chip
                      label={t('group.postingAllMembers')}
                      onPress={() => setPostingMode('all_members')}
                      selected={postingMode === 'all_members'}
                    />
                    <Chip
                      label={t('group.postingAdminsOnly')}
                      onPress={() => setPostingMode('admins_only')}
                      selected={postingMode === 'admins_only'}
                    />
                  </View>
                </View>
                {personalRealm ? null : (
                <View style={styles.policyField}>
                  <Text style={styles.label}>{t('group.joinPolicy')}</Text>
                  {lockedInviteOnly ? (
                    <StatusBadge icon="lock-closed" label={t('group.joinInviteOnly')} tone="success" />
                  ) : (
                    <View style={styles.chips}>
                      <Chip
                        label={t('group.joinInherit')}
                        onPress={() => setJoinPolicy('inherit')}
                        selected={joinPolicy === 'inherit'}
                      />
                      <Chip
                        label={t('group.joinInviteOnly')}
                        onPress={() => setJoinPolicy('invite_only')}
                        selected={joinPolicy === 'invite_only'}
                      />
                      <Chip
                        label={t('group.joinApproval')}
                        onPress={() => setJoinPolicy('approval_required')}
                        selected={joinPolicy === 'approval_required'}
                      />
                    </View>
                  )}
                  <Text style={styles.helperText}>
                    {lockedInviteOnly ? t('group.joinLockedDisclosure') : t('group.joinPolicyDisclosure')}
                  </Text>
                </View>
                )}
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('group.historyPolicy')}</Text>
                <View style={styles.chips}>
                  <Chip
                    label={t('group.historySinceJoin')}
                    onPress={() => setHistoryPolicy('since_join')}
                    selected={historyPolicy === 'since_join'}
                  />
                  <Chip
                    label={t('group.historyAll')}
                    onPress={() => setHistoryPolicy('all')}
                    selected={historyPolicy === 'all'}
                  />
                </View>
                <View style={styles.policyNotice}>
                  <Ionicons name="time-outline" color={colors.mintDark} size={17} />
                  <Text style={styles.policyNoticeText}>
                    {historyPolicy === 'all'
                      ? t('group.historyAllDisclosure')
                      : t('group.historySinceJoinDisclosure')}
                  </Text>
                </View>
              </View>

              {kind === 'incident' ? (
                <View style={styles.incidentFields}>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>{t('group.incidentSeverity')}</Text>
                    <View style={styles.chips}>
                      {(['low', 'medium', 'high', 'critical'] as const).map((severity) => (
                        <Chip
                          key={severity}
                          label={t(`group.incidentSeverity${severity[0]?.toUpperCase()}${severity.slice(1)}` as Parameters<typeof t>[0])}
                          onPress={() => setIncidentSeverity(severity)}
                          selected={incidentSeverity === severity}
                        />
                      ))}
                    </View>
                  </View>
                  <FormField
                    label={t('group.incidentClassification')}
                    onChangeText={setIncidentClassification}
                    placeholder={t('group.incidentClassificationPlaceholder')}
                    value={incidentClassification}
                  />
                  <View style={styles.incidentNotice}>
                    <Ionicons name="warning-outline" color={colors.red} size={17} />
                    <Text style={styles.incidentNoticeText}>{t('group.incidentDisclosure')}</Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.creationBoundary}>
                <Ionicons name="shield-checkmark-outline" color={colors.blue} size={18} />
                <View style={styles.creationBoundaryCopy}>
                  <Text style={styles.creationBoundaryTitle}>{t('group.atomicTitle')}</Text>
                  <Text style={styles.creationBoundaryText}>{t('group.atomicDisclosure')}</Text>
                </View>
              </View>
              <ActionError message={workspace.actionError} />
            </View>
          </View>

          <View style={styles.membersColumn}>
            <View style={styles.memberHeader}>
              <View style={styles.memberHeaderCopy}>
                <Text style={styles.eyebrow}>{t('group.members')}</Text>
                <Text style={styles.sectionTitle}>
                  {Object.keys(selected).length} {t('group.selectedSuffix')}
                </Text>
              </View>
              <StatusBadge icon="shield-checkmark" label={joinPolicyLabel} tone="success" />
            </View>
            <Text style={styles.candidatePrivacy}>{t('group.candidatePrivacy')}</Text>
            <SearchField onChangeText={setSearch} placeholder={t('group.search')} value={search} />

            {selectedGuests.length ? (
              <View style={styles.guestDisclosure}>
                <Ionicons name="time-outline" color={colors.amber} size={18} />
                <Text style={styles.guestDisclosureText}>{t('group.guestDisclosure')}</Text>
              </View>
            ) : null}

            <View style={styles.peopleList}>
              {candidatesLoading ? (
                <View style={styles.emptyCandidates}>
                  <Text style={styles.helperText}>{t('group.loadingCandidates')}</Text>
                </View>
              ) : visibleCandidates.length === 0 ? (
                <View style={styles.emptyCandidates}>
                  <Text style={styles.helperText}>{t('group.noCandidates')}</Text>
                </View>
              ) : visibleCandidates.map((candidate) => {
                const role = selected[candidate.userId];
                const expiresAt = candidate.accessExpiresAt
                  ? new Date(candidate.accessExpiresAt).toLocaleDateString(
                      locale === 'ko' ? 'ko-KR' : locale === 'es' ? 'es-MX' : 'en-US',
                    )
                  : null;
                const membershipLabel = candidate.membershipType === 'guest'
                  ? t('group.guest')
                  : candidate.membershipType === 'contractor'
                    ? t('group.contractor')
                    : t('group.employee');
                return (
                  <View key={candidate.userId} style={[styles.personRow, role && styles.personRowSelected]}>
                    <Pressable
                      accessibilityLabel={`${role ? t('group.removePerson') : t('group.addPerson')} ${candidate.displayName}`}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: Boolean(role) }}
                      onPress={() => toggle(candidate)}
                      style={styles.personMain}>
                      <View style={[styles.check, role && styles.checkSelected]}>
                        {role ? <Ionicons name="checkmark" size={15} color={colors.forest} /> : null}
                      </View>
                      <Avatar
                        color={candidateColor(candidate)}
                        initials={candidateInitials(candidate.displayName)}
                        size={44}
                      />
                      <View style={styles.personCopy}>
                        <View style={styles.personTitleRow}>
                          <Text numberOfLines={1} style={styles.personName}>{candidate.displayName}</Text>
                          <StatusBadge
                            label={membershipLabel}
                            tone={candidate.membershipType === 'guest'
                              ? 'warning'
                              : candidate.membershipType === 'contractor' ? 'purple' : 'neutral'}
                          />
                        </View>
                        <Text numberOfLines={1} style={styles.personMeta}>
                          {candidate.jobTitle ?? candidate.membershipRole}
                        </Text>
                        {expiresAt ? (
                          <Text style={styles.expiryText}>{t('group.accessUntil')} {expiresAt}</Text>
                        ) : null}
                      </View>
                    </Pressable>
                    {role ? (
                      candidate.membershipType === 'guest' ? (
                        <View style={styles.guestRoleRow}>
                          <StatusBadge label={t('group.member')} tone="warning" />
                          <Text style={styles.helperText}>{t('group.guestRoleLocked')}</Text>
                        </View>
                      ) : personalRealm ? null : (
                        <View style={styles.roles}>
                          <Chip
                            label={t('group.member')}
                            onPress={() => setRole(candidate, 'member')}
                            selected={role === 'member'}
                          />
                          <Chip
                            label={t('group.admin')}
                            onPress={() => setRole(candidate, 'admin')}
                            selected={role === 'admin'}
                          />
                          <Chip
                            label={t('group.owner')}
                            onPress={() => setRole(candidate, 'owner')}
                            selected={role === 'owner'}
                          />
                        </View>
                      )
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.paper,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.ink, fontFamily: type.display, fontSize: 19, fontWeight: '900' },
  headerSubtitle: { color: colors.inkSubtle, fontSize: 11, marginTop: 2 },
  page: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    padding: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  columns: { gap: spacing.lg },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  configurationColumn: { flex: 1, minWidth: 0 },
  membersColumn: { flex: 1, minWidth: 0, gap: spacing.sm },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  cardHeading: { gap: 2 },
  fieldGroup: { gap: spacing.xs },
  avatarField: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  avatarCopy: { gap: 3 },
  avatarRequirements: { color: colors.inkMuted, fontSize: 10, fontWeight: '700' },
  avatarSelection: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarPreview: { width: 82, height: 82, borderRadius: radii.lg, backgroundColor: colors.line },
  avatarSelectionCopy: { flex: 1, minWidth: 0, gap: spacing.sm },
  avatarSelectedText: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  avatarStatus: { color: colors.blue, fontSize: 11, fontWeight: '800' },
  avatarRecovery: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: '#E7C690',
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  avatarRecoveryText: { color: colors.amber, fontSize: 11, lineHeight: 16 },
  policyGrid: { gap: spacing.md },
  policyField: { gap: spacing.xs },
  label: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  helperText: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  policyNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  policyNoticeText: { flex: 1, color: colors.mintDark, fontSize: 11, lineHeight: 16 },
  incidentFields: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#F0C9C1',
    backgroundColor: colors.redSoft,
  },
  incidentNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  incidentNoticeText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 16 },
  creationBoundary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.blueSoft,
  },
  creationBoundaryCopy: { flex: 1, gap: 2 },
  creationBoundaryTitle: { color: colors.blue, fontSize: 12, fontWeight: '900' },
  creationBoundaryText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  memberHeader: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  memberHeaderCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  sectionTitle: { color: colors.ink, fontFamily: type.display, fontSize: 20, fontWeight: '900', marginTop: 2 },
  candidatePrivacy: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  guestDisclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#E7C690',
    backgroundColor: colors.amberSoft,
  },
  guestDisclosureText: { flex: 1, color: colors.amber, fontSize: 11, lineHeight: 16 },
  peopleList: { gap: spacing.sm },
  emptyCandidates: {
    alignItems: 'center',
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
  },
  personRow: {
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    gap: spacing.sm,
  },
  personRowSelected: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  personMain: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  check: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  checkSelected: { backgroundColor: colors.mint, borderColor: colors.mint },
  personCopy: { flex: 1, minWidth: 0, gap: 2 },
  personTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  personName: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '900' },
  personMeta: { color: colors.inkSubtle, fontSize: 11 },
  expiryText: { color: colors.amber, fontSize: 10, fontWeight: '800' },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingLeft: 80 },
  guestRoleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingLeft: 80,
  },
});
