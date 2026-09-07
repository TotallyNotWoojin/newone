import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { UserSearchResult } from '@/data/repositories/contracts';
import type {
  GroupCreationCandidate,
  InitialConversationRole,
} from '@/data/repositories/group-creation-dto.mjs';
import type { SelectedAttachment } from '@/data/attachments';
import type { Person } from '@/domain/types';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

type GroupKind = 'group' | 'team' | 'shift' | 'incident';
type PostingMode = 'all_members' | 'admins_only';
type JoinPolicy = 'inherit' | 'invite_only' | 'approval_required';

/** A picker row: the workplace candidate shape plus the consumer @handle. */
type PickerCandidate = GroupCreationCandidate & { username?: string | null };

function candidateInitials(displayName: string): string {
  return displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function candidateColor(candidate: GroupCreationCandidate): string {
  if (candidate.membershipType === 'guest') return '#A55822';
  if (candidate.membershipType === 'contractor') return '#6553A3';
  return '#3478A9';
}

function directoryCandidate(person: Person): PickerCandidate {
  return {
    userId: person.id,
    displayName: person.displayName,
    username: person.username ?? null,
    avatarPath: null,
    jobTitle: null,
    membershipRole: 'member',
    membershipType: 'employee',
    accessExpiresAt: null,
  };
}

function searchCandidate(result: UserSearchResult): PickerCandidate {
  return {
    userId: result.userId,
    displayName: result.displayName ?? result.username,
    username: result.username,
    avatarPath: result.avatarPath,
    jobTitle: null,
    membershipRole: 'member',
    membershipType: 'employee',
    accessExpiresAt: null,
  };
}

/**
 * The name is optional, so an unnamed group is titled by the people in it, the
 * way the phone titles a group message.
 */
export function groupNameFromPeople(names: string[], fallback: string): string {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (!cleaned.length) return fallback;
  const shown = cleaned.slice(0, 3).join(', ');
  const rest = cleaned.length - 3;
  const title = rest > 0 ? `${shown} +${rest}` : shown;
  return title.length > 160 ? `${title.slice(0, 157)}…` : title;
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<PickerCandidate[]>([]);
  const [candidateCache, setCandidateCache] = useState<Record<string, PickerCandidate>>({});
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, InitialConversationRole>>({});
  const [avatar, setAvatar] = useState<SelectedAttachment | null>(null);
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const [avatarUploadFailed, setAvatarUploadFailed] = useState(false);
  const requestSequence = useRef(0);
  const wide = width >= 920;
  const lockedInviteOnly = kind === 'shift' || kind === 'incident';
  // The personal realm is a consumer messenger: no workplace conversation
  // kinds and no owner/admin promotion at creation. Anyone can be added: the
  // picker lists this account's contacts first and finds everyone else
  // underneath, through the same people search as the Contacts tab.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const searchUsers = workspace.searchUsers;
  const people = workspace.people;
  const directoryCandidates = useMemo(
    () => (personalRealm
      ? people
          .filter((person) => person.connectionState !== 'self' && !person.blockedByMe)
          .map(directoryCandidate)
      : []),
    [people, personalRealm],
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

  const rememberCandidates = useCallback((next: PickerCandidate[]) => {
    setCandidates(next);
    setCandidateCache((current) => ({
      ...current,
      ...Object.fromEntries(next.map((candidate) => [candidate.userId, candidate])),
    }));
    setCandidatesLoading(false);
  }, []);

  useEffect(() => {
    if (personalRealm) return;
    const sequence = ++requestSequence.current;
    const timer = setTimeout(() => {
      setCandidatesLoading(true);
      void queryCandidates(search).then((result) => {
        if (requestSequence.current !== sequence) return;
        rememberCandidates(result ?? []);
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [personalRealm, queryCandidates, rememberCandidates, search]);

  // Consumer picker, short query: the contacts this account already has,
  // narrowed locally by name or handle. Derived, never fetched.
  const shortConsumerQuery = personalRealm && search.trim().length < 2;
  const knownCandidates = useMemo(() => {
    const lowered = search.trim().toLocaleLowerCase();
    return directoryCandidates.filter((candidate) => (
      !lowered
      || candidate.displayName.toLocaleLowerCase().includes(lowered)
      || (candidate.username ?? '').startsWith(lowered)
    ));
  }, [directoryCandidates, search]);

  // Consumer picker, real query: the same people search as the Contacts tab. A
  // query that drops under two characters only invalidates the search in
  // flight; the contacts list above stands on its own.
  useEffect(() => {
    if (!personalRealm) return;
    const normalized = search.trim();
    const sequence = ++requestSequence.current;
    if (normalized.length < 2) {
      setCandidates([]);
      setCandidatesLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setCandidatesLoading(true);
      void searchUsers(normalized).then((results) => {
        if (requestSequence.current !== sequence) return;
        rememberCandidates((results ?? []).map(searchCandidate));
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [personalRealm, rememberCandidates, search, searchUsers]);

  // Two visibly separate intents: the people you already know, then everyone
  // else. A stranger already in the contacts list is never listed twice.
  const knownIds = useMemo(
    () => new Set(directoryCandidates.map((candidate) => candidate.userId)),
    [directoryCandidates],
  );
  const strangerCandidates = useMemo(
    () => (personalRealm && !shortConsumerQuery
      ? candidates.filter((candidate) => !knownIds.has(candidate.userId))
      : []),
    [candidates, knownIds, personalRealm, shortConsumerQuery],
  );

  // A selected person may have come from the contacts list, which is derived
  // rather than fetched, so both sources answer "who is this id?".
  const candidateById = useMemo(() => {
    const known: Record<string, PickerCandidate> = { ...candidateCache };
    for (const candidate of directoryCandidates) known[candidate.userId] ??= candidate;
    return known;
  }, [candidateCache, directoryCandidates]);

  const selectedGuests = useMemo(
    () => Object.keys(selected)
      .map((userId) => candidateById[userId])
      .filter((candidate): candidate is PickerCandidate => candidate?.membershipType === 'guest'),
    [candidateById, selected],
  );

  const selectKind = (nextKind: GroupKind) => {
    setKind(nextKind);
    if (nextKind === 'shift' || nextKind === 'incident') setJoinPolicy('invite_only');
  };

  const finish = (conversationId: string) => {
    if (width >= 920) router.replace('/');
    else router.replace({ pathname: '/conversation/[id]', params: { id: conversationId } });
  };

  const submittedName = () => {
    const typed = name.trim();
    if (typed) return typed;
    return groupNameFromPeople(
      Object.keys(selected).map((userId) => candidateById[userId]?.displayName ?? ''),
      t('group.untitled'),
    );
  };

  const submit = async () => {
    const conversationId = createdConversationId ?? await workspace.createGroupConversation({
      name: submittedName(),
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
  const advancedSummary = `${
    t(postingMode === 'all_members' ? 'group.postEveryone' : 'group.postAdmins')
  } · ${
    t(historyPolicy === 'all' ? 'group.historyAllSummary' : 'group.historySinceJoinSummary')
  }`;

  const renderCandidate = (candidate: PickerCandidate) => {
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
            size={personalRealm ? 36 : 44}
          />
          <View style={styles.personCopy}>
            <View style={styles.personTitleRow}>
              <Text numberOfLines={1} style={styles.personName}>{candidate.displayName}</Text>
              {personalRealm ? null : (
                <StatusBadge
                  label={membershipLabel}
                  tone={candidate.membershipType === 'guest'
                    ? 'warning'
                    : candidate.membershipType === 'contractor' ? 'purple' : 'neutral'}
                />
              )}
            </View>
            {personalRealm ? (
              candidate.username ? (
                <Text numberOfLines={1} style={styles.personMeta}>{`@${candidate.username}`}</Text>
              ) : null
            ) : (
              <Text numberOfLines={1} style={styles.personMeta}>
                {[
                  candidate.jobTitle ?? candidate.membershipRole,
                  candidate.username ? `@${candidate.username}` : null,
                ].filter(Boolean).join(' · ')}
              </Text>
            )}
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
  };

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
          <Text numberOfLines={wide ? 2 : 1} style={styles.headerSubtitle}>{t(personalRealm ? 'group.subtitleConsumer' : 'group.subtitle')}</Text>
        </View>
        <PrimaryButton
          disabled={
            !createdConversationId && (
              (!personalRealm && name.trim().length < 2) ||
              Object.keys(selected).length < (personalRealm ? 2 : 1) ||
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
        {/* Identity first: a small round photo beside the name, then a single-line description. */}
        <View style={[styles.card, shadow]}>
          <View style={styles.identityRow}>
            <View style={styles.photoColumn}>
              <Pressable
                accessibilityLabel={avatar ? t('group.changeAvatar') : t('group.photoOptional')}
                accessibilityRole="button"
                onPress={() => void chooseAvatar()}
                style={styles.photo}>
                {avatar ? (
                  <Image
                    accessibilityLabel={t('group.avatarSelected')}
                    resizeMode="cover"
                    source={{ uri: avatar.uri }}
                    style={styles.photoImage}
                  />
                ) : (
                  <Ionicons name="camera-outline" color={colors.inkSubtle} size={22} />
                )}
              </Pressable>
              {avatar ? (
                <Pressable
                  accessibilityLabel={t('group.removeAvatar')}
                  accessibilityRole="button"
                  onPress={() => {
                    setAvatar(null);
                    setAvatarUploadFailed(false);
                  }}
                  style={styles.photoClear}>
                  <Ionicons name="close" color={colors.white} size={12} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.identityFields}>
              <FormField
                label={t('group.nameOptional')}
                onChangeText={setName}
                placeholder={t('group.nameOptionalPlaceholder')}
                value={name}
              />
              <FormField
                label={t('group.descriptionOptional')}
                onChangeText={setDescription}
                placeholder={t('group.descriptionOptionalPlaceholder')}
                value={description}
              />
            </View>
          </View>
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

          {/* Everything that is not the name, the photo, or the people. */}
          <View style={styles.advanced}>
            <Pressable
              accessibilityLabel={t('group.advancedOptions')}
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
              onPress={() => setAdvancedOpen((current) => !current)}
              style={styles.advancedToggle}>
              <Text style={styles.label}>{t('group.advancedOptions')}</Text>
              <Ionicons
                name={advancedOpen ? 'chevron-up' : 'chevron-down'}
                color={colors.inkSubtle}
                size={16}
              />
            </Pressable>
            {advancedOpen ? (
              <View style={styles.advancedBody}>
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

                <View style={styles.fieldGroup}>
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
                  <View style={styles.fieldGroup}>
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
                  {personalRealm ? null : (
                    <View style={styles.policyNotice}>
                      <Ionicons name="time-outline" color={colors.mintDark} size={17} />
                      <Text style={styles.policyNoticeText}>
                        {historyPolicy === 'all'
                          ? t('group.historyAllDisclosure')
                          : t('group.historySinceJoinDisclosure')}
                      </Text>
                    </View>
                  )}
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
              </View>
            ) : (
              <Text numberOfLines={1} style={styles.advancedSummary}>{advancedSummary}</Text>
            )}
          </View>
          <ActionError message={workspace.actionError} />
        </View>

        {/* Then the people. */}
        <View style={styles.membersColumn}>
          <View style={styles.memberHeader}>
            <View style={styles.memberHeaderCopy}>
              <Text style={styles.eyebrow}>{t('group.members')}</Text>
              <Text style={styles.sectionTitle}>
                {Object.keys(selected).length} {t('group.selectedSuffix')}
              </Text>
            </View>
            {personalRealm ? null : (
              <StatusBadge icon="shield-checkmark" label={joinPolicyLabel} tone="success" />
            )}
          </View>
          {personalRealm ? (
            // Said plainly on the form; the service refuses a smaller group too.
            <Text style={styles.minimumNote}>{t('group.minimumPeople')}</Text>
          ) : (
            <Text style={styles.candidatePrivacy}>{t('group.candidatePrivacy')}</Text>
          )}
          <SearchField
            onChangeText={setSearch}
            placeholder={t(personalRealm ? 'people.usernameSearch' : 'group.search')}
            value={search}
          />

          {selectedGuests.length ? (
            <View style={styles.guestDisclosure}>
              <Ionicons name="time-outline" color={colors.amber} size={18} />
              <Text style={styles.guestDisclosureText}>{t('group.guestDisclosure')}</Text>
            </View>
          ) : null}

          {personalRealm ? (
            <>
              {/* Contacts first: adding someone you know is not the same act as finding a stranger. */}
              <Text style={styles.pickerSection}>{t('group.contacts')}</Text>
              <View style={styles.peopleList}>
                {knownCandidates.length
                  ? knownCandidates.map(renderCandidate)
                  : (
                    <View style={styles.emptyCandidates}>
                      <Text style={styles.helperText}>
                        {search.trim() ? t('group.contactsEmpty') : t('group.pickerHint')}
                      </Text>
                    </View>
                  )}
              </View>
              <Text style={styles.pickerSection}>{t('group.searchEveryone')}</Text>
              <View style={styles.peopleList}>
                {shortConsumerQuery ? (
                  <View style={styles.emptyCandidates}>
                    <Text style={styles.helperText}>{t('group.pickerHint')}</Text>
                  </View>
                ) : candidatesLoading ? (
                  <View style={styles.emptyCandidates}>
                    <Text style={styles.helperText}>{t('group.loadingCandidates')}</Text>
                  </View>
                ) : strangerCandidates.length ? (
                  strangerCandidates.map(renderCandidate)
                ) : (
                  <View style={styles.emptyCandidates}>
                    <Text style={styles.helperText}>{t('people.usernameNoResults')}</Text>
                  </View>
                )}
              </View>
            </>
          ) : (
            <View style={styles.peopleList}>
              {candidatesLoading ? (
                <View style={styles.emptyCandidates}>
                  <Text style={styles.helperText}>{t('group.loadingCandidates')}</Text>
                </View>
              ) : candidates.length === 0 ? (
                <View style={styles.emptyCandidates}>
                  <Text style={styles.helperText}>{t('group.noCandidates')}</Text>
                </View>
              ) : candidates.map(renderCandidate)}
            </View>
          )}
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
    maxWidth: 720,
    alignSelf: 'center',
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  membersColumn: { gap: spacing.sm },
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  identityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  identityFields: { flex: 1, minWidth: 0, gap: spacing.xs },
  photoColumn: { width: 56, height: 56 },
  photo: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paperMuted,
    overflow: 'hidden',
  },
  photoImage: { width: '100%', height: '100%' },
  photoClear: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.forest,
  },
  fieldGroup: { gap: spacing.xs },
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
  advanced: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  advancedToggle: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  advancedSummary: { color: colors.inkSubtle, fontSize: 11 },
  advancedBody: { gap: spacing.md, paddingTop: spacing.xs },
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
  memberHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  memberHeaderCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  sectionTitle: { color: colors.ink, fontFamily: type.display, fontSize: 18, fontWeight: '900', marginTop: 2 },
  pickerSection: {
    color: colors.inkMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    marginTop: spacing.xs,
  },
  candidatePrivacy: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  minimumNote: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
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
  peopleList: { gap: spacing.xs },
  emptyCandidates: {
    alignItems: 'center',
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
  },
  personRow: {
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    gap: spacing.xs,
  },
  personRowSelected: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  personMain: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  check: {
    width: 22,
    height: 22,
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
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingLeft: 76 },
  guestRoleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingLeft: 76,
  },
});
