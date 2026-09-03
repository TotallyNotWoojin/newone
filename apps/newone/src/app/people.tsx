import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  AppScaffold,
  DesktopPageHeader,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import {
  Avatar,
  Chip,
  EmptyState,
  IconButton,
  PrimaryButton,
  SearchField,
  StatusBadge,
} from '@/components/ui/primitives';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { isPersonalRealm } from '@/constants/personal-realm';
import type { UserSearchResult } from '@/data/repositories/contracts';
import type { Person } from '@/domain/types';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';
import {
  moderationCopy,
  moderationMemberSafetyRouteNotice,
  moderationTargetReportConsentNotice,
} from '@/features/admin/moderation-copy';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

type PeopleFilter = 'all' | 'connected' | 'online' | 'my_site' | 'pending';

const USERNAME_SEARCH_DEBOUNCE_MS = 300;
const MESSAGE_REQUEST_MAX_LENGTH = 20_000;

function displayInitials(displayName: string) {
  return displayName.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toLocaleUpperCase() || 'N';
}

export default function PeopleScreen() {
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<PeopleFilter>('all');
  const [search, setSearch] = useState('');
  const [managePersonId, setManagePersonId] = useState('');
  const [contactAlias, setContactAlias] = useState('');
  const [favoriteContact, setFavoriteContact] = useState(false);
  const [reportCategory, setReportCategory] = useState<
    'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other'
  >('other');
  const [reportDetails, setReportDetails] = useState('');
  const [reportConsent, setReportConsent] = useState(false);
  const managePerson = workspace.people.find((person) => person.id === managePersonId);
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const [usernameQuery, setUsernameQuery] = useState('');
  const [usernameResults, setUsernameResults] = useState<UserSearchResult[]>([]);
  const [usernameSearched, setUsernameSearched] = useState(false);
  const [requestTarget, setRequestTarget] = useState<UserSearchResult | null>(null);
  const [requestBody, setRequestBody] = useState('');
  const usernameSequenceRef = useRef(0);
  const searchUsers = workspace.searchUsers;

  const handleUsernameQueryChange = (value: string) => {
    const next = value.toLocaleLowerCase();
    // Invalidate any in-flight search and clear settled results synchronously
    // in the event handler so the debounce effect only schedules fetches.
    usernameSequenceRef.current += 1;
    setUsernameQuery(next);
    if (next.trim().length < 2) {
      setUsernameResults([]);
      setUsernameSearched(false);
    }
  };

  useEffect(() => {
    const normalized = usernameQuery.trim();
    if (!personalRealm || normalized.length < 2) return;
    const sequence = ++usernameSequenceRef.current;
    const timer = setTimeout(() => {
      void searchUsers(normalized).then((results) => {
        if (usernameSequenceRef.current !== sequence) return;
        setUsernameSearched(true);
        setUsernameResults(results ?? []);
      });
    }, USERNAME_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [personalRealm, searchUsers, usernameQuery]);

  const patchUsernameResult = (
    userId: string,
    connectionState: UserSearchResult['connectionState'],
  ) => {
    setUsernameResults((current) => current.map((result) =>
      result.userId === userId ? { ...result, connectionState } : result));
  };
  const safetyCopy = moderationCopy(locale);
  const reportCategoryLabels = {
    harassment: t('chat.reportHarassment'),
    threat: t('chat.reportThreat'),
    spam: t('chat.reportSpam'),
    privacy: t('chat.reportPrivacy'),
    misinformation: t('chat.reportMisinformation'),
    other: t('chat.reportOther'),
  };
  const currentSite = workspace.currentUser?.site ?? null;

  const people = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return workspace.people.filter((person) => {
      if (person.connectionState === 'self') return false;
      const matchesQuery =
        !query ||
        person.displayName.toLocaleLowerCase().includes(query) ||
        person.roleLabel.toLocaleLowerCase().includes(query) ||
        person.department.toLocaleLowerCase().includes(query) ||
        person.site.toLocaleLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (filter === 'connected') return person.connectionState === 'connected';
      if (filter === 'online') return person.presence === 'online';
      if (filter === 'my_site') return currentSite !== null && person.site === currentSite;
      if (filter === 'pending') return person.connectionState === 'pending';
      return true;
    });
  }, [currentSite, filter, search, workspace.people]);
  // Consumer accounts get a plain friends-and-requests list instead of the
  // workplace directory; strangers only appear through username search.
  const consumerFriends = useMemo(
    () => workspace.people.filter((person) => person.connectionState === 'connected'),
    [workspace.people],
  );
  const consumerRequests = useMemo(
    () => workspace.people.filter((person) => person.connectionState === 'pending'),
    [workspace.people],
  );

  const openMessage = async (person: Person) => {
    const conversationId = await workspace.openOrCreateDirectConversation(person.id);
    if (!conversationId) return;

    if (desktop) {
      router.replace('/');
    } else {
      router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
    }
  };

  const openManage = (person: Person) => {
    workspace.clearActionError();
    setContactAlias(person.contactAlias ?? '');
    setFavoriteContact(person.favoriteContact === true);
    setReportCategory('other');
    setReportDetails('');
    setReportConsent(false);
    setManagePersonId(person.id);
  };

  const renderPersonCard = (person: Person) => (
    <PersonCard
      desktop={desktop}
      key={person.id}
      onConnect={() => void workspace.updateConnection(person.id)}
      onDecline={() => void workspace.respondConnection(person.id, 'declined')}
      onAccept={() => void workspace.respondConnection(person.id, 'accepted')}
      onMessage={() => void openMessage(person)}
      onManage={() => openManage(person)}
      onRemove={() => void workspace.removeConnection(person.id)}
      person={personalRealm && person.username ? { ...person, roleLabel: `@${person.username}` } : person}
    />
  );

  const searchResultPerson = (result: UserSearchResult): Person => {
    const known = workspace.people.find((person) => person.id === result.userId);
    const name = result.displayName ?? result.username;
    return {
      id: result.userId,
      membershipId: result.userId,
      displayName: name,
      initials: displayInitials(name),
      roleLabel: `@${result.username}`,
      role: 'employee',
      site: '',
      department: '',
      preferredLanguage: known?.preferredLanguage ?? 'en',
      presence: known?.presence ?? 'offline',
      connectionState: result.connectionState === 'accepted'
        ? 'connected'
        : result.connectionState === 'none'
          ? 'available'
          : 'pending',
      connectionRequestDirection: result.connectionState === 'pending_incoming'
        ? 'incoming'
        : result.connectionState === 'pending_outgoing'
          ? 'outgoing'
          : undefined,
      avatarColor: known?.avatarColor ?? colors.forest,
    };
  };

  const connectFromSearch = async (result: UserSearchResult) => {
    if (await workspace.updateConnection(result.userId)) {
      patchUsernameResult(result.userId, 'pending_outgoing');
    }
  };

  const respondFromSearch = async (result: UserSearchResult, decision: 'accepted' | 'declined') => {
    if (await workspace.respondConnection(result.userId, decision)) {
      patchUsernameResult(result.userId, decision === 'accepted' ? 'accepted' : 'none');
    }
  };

  const cancelFromSearch = async (result: UserSearchResult) => {
    if (await workspace.removeConnection(result.userId)) {
      patchUsernameResult(result.userId, 'none');
    }
  };

  const openRequestCompose = (result: UserSearchResult) => {
    workspace.clearActionError();
    setRequestBody('');
    setRequestTarget(result);
  };

  const sendRequest = async () => {
    if (!requestTarget) return;
    const conversationId = await workspace.sendMessageRequest(
      requestTarget.userId,
      requestBody,
      requestTarget.displayName ?? requestTarget.username,
    );
    if (!conversationId) return;
    patchUsernameResult(requestTarget.userId, 'pending_outgoing');
    setRequestTarget(null);
    setRequestBody('');
    if (desktop) {
      router.replace('/');
    } else {
      router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
    }
  };

  return (
    <AppScaffold
      current="people"
      mobileHeader={
        <MobileBrandHeader
          subtitle={t(personalRealm ? 'people.subtitleConsumer' : 'people.subtitle')}
          title={t('people.title')}
        />
      }>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error'
        || (workspace.people.length <= 1 && !personalRealm) ? (
        <WorkspaceStatePanel resource="people" />
      ) : (
      // Keeps the username search field and its first results above the iOS
      // keyboard; taps on results must not be swallowed by keyboard dismissal.
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}>
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {desktop ? (
          <DesktopPageHeader
            description={t(personalRealm ? 'people.descriptionConsumer' : 'people.description')}
            eyebrow={t(personalRealm ? 'people.eyebrowConsumer' : 'people.eyebrow')}
            title={t('people.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
          {personalRealm ? (
            <View style={[styles.usernameSearch, shadow]}>
              <Text style={styles.usernameTitle}>{t('people.usernameSearchTitle')}</Text>
              <SearchField
                onChangeText={handleUsernameQueryChange}
                placeholder={t('people.usernameSearch')}
                value={usernameQuery}
              />
              <Text style={styles.usernameHint}>{t('people.usernameSearchHint')}</Text>
              {usernameResults.length ? (
                <View style={styles.peopleGrid}>
                  {usernameResults.map((result) => (
                    <PersonCard
                      desktop={desktop}
                      key={result.userId}
                      usernameResult
                      onAccept={() => void respondFromSearch(result, 'accepted')}
                      onConnect={() => void connectFromSearch(result)}
                      onDecline={() => void respondFromSearch(result, 'declined')}
                      onMessage={() => void openMessage(searchResultPerson(result))}
                      onMessageRequest={() => openRequestCompose(result)}
                      onRemove={() => void cancelFromSearch(result)}
                      person={searchResultPerson(result)}
                    />
                  ))}
                </View>
              ) : usernameSearched ? (
                <Text style={styles.usernameEmpty}>{t('people.usernameNoResults')}</Text>
              ) : null}
            </View>
          ) : null}
          {personalRealm ? (
            <View style={styles.consumerSections}>
              {consumerRequests.length ? (
                <View style={styles.consumerSection}>
                  <Text style={styles.directoryEyebrow}>{t('people.requests')}</Text>
                  <View style={styles.peopleGrid}>
                    {consumerRequests.map(renderPersonCard)}
                  </View>
                </View>
              ) : null}
              <View style={styles.consumerSection}>
                <Text style={styles.directoryEyebrow}>{t('people.friends')}</Text>
                {consumerFriends.length ? (
                  <View style={styles.peopleGrid}>
                    {consumerFriends.map(renderPersonCard)}
                  </View>
                ) : (
                  <EmptyState
                    body={t('people.friendsEmptyBody')}
                    icon="people-outline"
                    title={t('people.friendsEmpty')}
                  />
                )}
              </View>
            </View>
          ) : (
            <>
              <View style={[styles.directoryTools, shadow]}>
                <SearchField
                  onChangeText={setSearch}
                  placeholder={t('people.search')}
                  value={search}
                />
                <ScrollView
                  horizontal
                  contentContainerStyle={styles.filters}
                  showsHorizontalScrollIndicator={false}>
                  {[
                    ['all', t('people.everyone')],
                    ['connected', t('people.connections')],
                    ['online', t('people.online')],
                    ['my_site', t('people.mySite')],
                    ['pending', t('people.pending')],
                  ].map(([id, label]) => (
                    <Chip
                      key={id}
                      label={label}
                      onPress={() => setFilter(id as PeopleFilter)}
                      selected={filter === id}
                    />
                  ))}
                </ScrollView>
              </View>

              <View style={styles.directoryTopline}>
                <View>
                  <Text style={styles.directoryEyebrow}>{t('people.directory')}</Text>
                  <Text style={styles.directoryTitle}>{people.length} {t('people.countSuffix')}</Text>
                </View>
                <View style={styles.directoryPrivacy}>
                  <Ionicons name="shield-checkmark" size={14} color={colors.mintDark} />
                  <Text style={styles.directoryPrivacyText}>{t('people.safeFields')}</Text>
                </View>
              </View>

              <View style={styles.peopleGrid}>
                {people.length ? (
                  people.map(renderPersonCard)
                ) : (
                  <EmptyState
                    body={t('status.emptyPeopleBody')}
                    icon="search-outline"
                    title={t('status.emptyPeople')}
                  />
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
      )}
      <ActionModal
        description={t('people.manageDescription')}
        onClose={() => setManagePersonId('')}
        title={managePerson ? `${t('people.manageTitle')} · ${managePerson.displayName}` : t('people.manageTitle')}
        visible={Boolean(managePerson)}>
        <FormField
          label={t('people.alias')}
          onChangeText={setContactAlias}
          placeholder={t('people.aliasPlaceholder')}
          value={contactAlias}
        />
        <PrimaryButton
          icon={favoriteContact ? 'star' : 'star-outline'}
          label={t('people.favoriteContact')}
          onPress={() => setFavoriteContact((current) => !current)}
          tone={favoriteContact ? 'dark' : 'light'}
        />
        <View style={styles.privacyNote}>
          <Ionicons name="shield-checkmark-outline" color={colors.inkSubtle} size={17} />
          <Text style={styles.privacyNoteText}>
            {t(personalRealm ? 'people.blockNoticeConsumer' : 'people.blockNotice')}
          </Text>
        </View>
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          icon="bookmark-outline"
          label={t('people.saveContact')}
          loading={workspace.actionBusy === 'contact-save'}
          onPress={async () => {
            if (managePerson && await workspace.saveContact(managePerson.id, contactAlias, favoriteContact)) {
              setContactAlias(contactAlias.trim());
            }
          }}
          tone="dark"
        />
        {managePerson?.savedContact ? (
          <PrimaryButton
            icon="bookmark"
            label={t('people.removeSaved')}
            loading={workspace.actionBusy === 'contact-remove'}
            onPress={() => managePerson && void workspace.removeSavedContact(managePerson.id)}
            tone="light"
          />
        ) : null}
        <PrimaryButton
          icon={managePerson?.blockedByMe ? 'shield-checkmark-outline' : 'ban-outline'}
          label={managePerson?.blockedByMe ? t('people.unblock') : t('people.block')}
          loading={workspace.actionBusy === (managePerson?.blockedByMe ? 'person-unblock' : 'person-block')}
          onPress={() => managePerson && void workspace.setPersonBlocked(managePerson.id, !managePerson.blockedByMe)}
          tone={managePerson?.blockedByMe ? 'light' : 'danger'}
        />
        <View style={styles.reportSection}>
          <Text style={styles.reportTitle}>{t('people.reportPrivately')}</Text>
          <Text style={styles.reportNote}>{t('people.reportDescription')}</Text>
          <View style={styles.reportCategories}>
            {(['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const)
              .map((category) => (
                <Chip
                  key={`member-report-${category}`}
                  label={reportCategoryLabels[category]}
                  onPress={() => {
                    setReportCategory(category);
                    setReportConsent(false);
                  }}
                  selected={reportCategory === category}
                />
              ))}
          </View>
          <FormField
            label={t('chat.reportDetails')}
            multiline
            onChangeText={(value) => {
              setReportDetails(value);
              setReportConsent(false);
            }}
            value={reportDetails}
          />
          <View style={styles.reportDisclosure}>
            <Text style={styles.reportDisclosureText}>
              {moderationTargetReportConsentNotice(locale, 'member')}
            </Text>
            <Text style={styles.reportRouteText}>
              {moderationMemberSafetyRouteNotice(locale)}
            </Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: reportConsent }}
              onPress={() => setReportConsent((value) => !value)}
              style={({ pressed }) => [
                styles.reportConsent,
                reportConsent && styles.reportConsentChecked,
                pressed && styles.reportConsentPressed,
              ]}>
              <Ionicons
                name={reportConsent ? 'checkbox' : 'square-outline'}
                color={reportConsent ? colors.mintDark : colors.inkSubtle}
                size={22}
              />
              <Text style={styles.reportConsentText}>{safetyCopy.reportConsentLabel}</Text>
            </Pressable>
          </View>
          <PrimaryButton
            disabled={!managePerson || !reportConsent}
            icon="flag-outline"
            label={t('chat.submitReport')}
            loading={workspace.actionBusy === 'member-report'}
            onPress={async () => {
              if (managePerson && await workspace.reportMember(
                managePerson.membershipId ?? managePerson.id,
                reportCategory,
                reportDetails,
                { consentToShare: true, noticeVersion: 'moderation-report-v2' },
              )) setManagePersonId('');
            }}
            tone="danger"
          />
        </View>
      </ActionModal>
      <ActionModal
        description={t('people.messageRequestDescription')}
        onClose={() => setRequestTarget(null)}
        title={requestTarget
          ? `${t('people.messageRequestTitle')} · ${requestTarget.displayName ?? requestTarget.username}`
          : t('people.messageRequestTitle')}
        visible={Boolean(requestTarget)}>
        <FormField
          label={t('people.messageRequestLabel')}
          multiline
          onChangeText={(value) => setRequestBody(value.slice(0, MESSAGE_REQUEST_MAX_LENGTH))}
          placeholder={t('people.messageRequestPlaceholder')}
          value={requestBody}
        />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!requestBody.trim()}
          icon="paper-plane-outline"
          label={t('people.messageRequestSend')}
          loading={workspace.actionBusy === 'message-request'}
          onPress={() => void sendRequest()}
          tone="dark"
        />
      </ActionModal>
    </AppScaffold>
  );
}

function PersonCard({
  person,
  onConnect,
  onAccept,
  onDecline,
  onMessage,
  onManage,
  onMessageRequest,
  onRemove,
  desktop,
  usernameResult = false,
}: {
  person: Person;
  onConnect: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onMessage: () => void;
  onManage?: () => void;
  onMessageRequest?: () => void;
  onRemove: () => void;
  desktop: boolean;
  usernameResult?: boolean;
}) {
  const { t } = useI18n();
  const connected = person.connectionState === 'connected';
  const pending = person.connectionState === 'pending';
  const manageButton = onManage
    ? <IconButton label={t('people.manage')} name="ellipsis-horizontal" onPress={onManage} />
    : null;
  return (
    <View style={[styles.personCard, !desktop && styles.personCardMobile, shadow]}>
      <View style={styles.personTopline}>
        <Avatar
          color={person.avatarColor}
          initials={person.initials}
          presence={person.presence}
          size={52}
        />
        <View style={styles.personStatus}>
          {person.blockedByMe ? <StatusBadge icon="ban-outline" label={t('people.blocked')} tone="danger" /> : null}
          {person.favoriteContact ? <StatusBadge icon="star" label={t('people.favorite')} tone="warning" /> : person.savedContact ? <StatusBadge icon="bookmark" label={t('people.saved')} tone="success" /> : null}
          {usernameResult ? null : (
            <StatusBadge
              label={person.preferredLanguage === 'ko' ? '한국어' : person.preferredLanguage === 'es' ? 'Español' : 'English'}
              tone={person.preferredLanguage === 'ko' ? 'purple' : 'warning'}
            />
          )}
        </View>
      </View>
      <Text style={styles.personName}>{person.displayName}</Text>
      <Text style={styles.personRole}>{person.roleLabel}</Text>
      {person.site ? (
        <View style={styles.personMetaRow}>
          <Ionicons name="business-outline" size={13} color={colors.inkSubtle} />
          <Text numberOfLines={1} style={styles.personMeta}>{person.site}</Text>
        </View>
      ) : null}
      {person.department ? (
        <View style={styles.personMetaRow}>
          <Ionicons name="git-network-outline" size={13} color={colors.inkSubtle} />
          <Text numberOfLines={1} style={styles.personMeta}>{person.department}</Text>
        </View>
      ) : null}
      <View style={styles.personActions}>
        {person.blockedByMe ? (
          onManage
            ? <PrimaryButton icon="options-outline" label={t('people.manage')} onPress={onManage} tone="light" />
            : null
        ) : connected ? (
          <>
            <PrimaryButton icon="chatbubble-outline" label={t('people.message')} onPress={onMessage} />
            <IconButton label={t('people.removeConnection')} name="person-remove-outline" onPress={onRemove} tone="danger" />
            {manageButton}
          </>
        ) : pending && person.connectionRequestDirection === 'incoming' ? (
          <>
            <PrimaryButton icon="checkmark" label={t('people.accept')} onPress={onAccept} tone="dark" />
            <PrimaryButton icon="close" label={t('people.decline')} onPress={onDecline} tone="light" />
            {manageButton}
          </>
        ) : pending ? (
          <>
            <PrimaryButton icon="close" label={t('people.cancelRequest')} onPress={onRemove} tone="light" />
            {manageButton}
          </>
        ) : (
          <>
            {onMessageRequest ? (
              <PrimaryButton
                icon="paper-plane-outline"
                label={t('people.sendMessageRequest')}
                onPress={onMessageRequest}
                tone="dark"
                style={styles.connectButton}
              />
            ) : null}
            <PrimaryButton
              icon="person-add-outline"
              label={t('people.connect')}
              onPress={onConnect}
              tone={onMessageRequest ? 'light' : 'dark'}
              style={onMessageRequest ? undefined : styles.connectButton}
            />
            {manageButton}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
  },
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
  consumerSections: {
    gap: spacing.xl,
  },
  consumerSection: {
    gap: spacing.sm,
  },
  directoryTools: {
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  usernameSearch: {
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  usernameTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 15,
    fontWeight: '900',
  },
  usernameHint: {
    color: colors.inkSubtle,
    fontSize: 10,
    lineHeight: 15,
  },
  usernameEmpty: {
    color: colors.inkMuted,
    fontSize: 12,
    paddingVertical: spacing.sm,
  },
  filters: {
    gap: spacing.xs,
  },
  directoryTopline: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  directoryEyebrow: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  directoryTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 21,
    fontWeight: '800',
    marginTop: 3,
  },
  directoryPrivacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  directoryPrivacyText: {
    color: colors.inkSubtle,
    fontSize: 10,
  },
  peopleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  personCard: {
    minWidth: 250,
    flexGrow: 1,
    flexBasis: 250,
    maxWidth: 360,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  personCardMobile: {
    maxWidth: '100%',
    flexBasis: '100%',
  },
  personTopline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  personStatus: {
    alignItems: 'flex-end',
    gap: 4,
  },
  personName: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 17,
    fontWeight: '900',
    marginTop: spacing.md,
  },
  personRole: {
    color: colors.inkMuted,
    fontSize: 12,
    marginTop: 3,
    marginBottom: spacing.md,
  },
  personMetaRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  personMeta: {
    flex: 1,
    color: colors.inkSubtle,
    fontSize: 10,
  },
  personActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  connectButton: {
    flex: 1,
  },
  reportSection: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  reportTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  reportNote: { color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  reportCategories: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  reportDisclosure: { gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.amberSoft },
  reportDisclosureText: { color: colors.amber, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  reportRouteText: { color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  reportConsent: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.xs, borderRadius: radii.sm },
  reportConsentChecked: { backgroundColor: colors.mintSoft },
  reportConsentPressed: { opacity: 0.75 },
  reportConsentText: { flex: 1, color: colors.ink, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  privacyNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  privacyNoteText: { flex: 1, color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
});
