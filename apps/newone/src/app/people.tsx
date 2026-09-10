import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { KeyboardAvoidingScreen } from '@/components/ui/keyboard-avoiding-screen';
import { isPersonalRealm } from '@/constants/personal-realm';
import type { UserSearchResult } from '@/data/repositories/contracts';
import type { Person } from '@/domain/types';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { personDisplayName } from '@/domain/person-name';
import { useI18n } from '@/i18n/provider';
import {
  moderationCopy,
  moderationMemberSafetyRouteNotice,
  moderationTargetReportConsentNotice,
} from '@/features/admin/moderation-copy';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';
import { a11yState } from '@/lib/a11y-state';

type PeopleFilter = 'all' | 'connected' | 'online' | 'my_site' | 'pending';

const PEOPLE_SEARCH_DEBOUNCE_MS = 300;

function displayInitials(displayName: string) {
  return displayName.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toLocaleUpperCase() || 'N';
}

export default function PeopleScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<PeopleFilter>('all');
  const [search, setSearch] = useState('');
  const [managePersonId, setManagePersonId] = useState('');
  // Declining asks first: a mis-tap on a shifting list once declined a request
  // outright (run-2026-09-04T20-41-40), and a decline cannot be undone.
  const [decliningPersonId, setDecliningPersonId] = useState('');
  const [contactAlias, setContactAlias] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState<
    'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other'
  >('other');
  const [reportDetails, setReportDetails] = useState('');
  const [reportConsent, setReportConsent] = useState(false);
  const managePerson = workspace.people.find((person) => person.id === managePersonId);
  const decliningPerson = workspace.people.find((person) => person.id === decliningPersonId);
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleResults, setPeopleResults] = useState<UserSearchResult[]>([]);
  const [peopleSearched, setPeopleSearched] = useState(false);
  const peopleSequenceRef = useRef(0);
  const searchUsers = workspace.searchUsers;
  const searching = peopleQuery.trim().length >= 2;
  // Contacts searches the people already known; finding a stranger is a
  // deliberate, separate act that lives in its own sheet.
  const [contactQuery, setContactQuery] = useState('');
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  const routeParams = useLocalSearchParams<{ add?: string; report?: string }>();
  const addParam = routeParams.add;
  const reportParam = routeParams.report;
  const [seenAddParam, setSeenAddParam] = useState<string | undefined>(undefined);
  const [seenReportParam, setSeenReportParam] = useState<string | undefined>(undefined);
  // The "+" menu on Chats routes here with ?add=1, so one control on one
  // screen is the only way in. The parameter is read as it arrives rather than
  // in an effect, which would render the screen twice on the way in.
  if (addParam !== seenAddParam) {
    setSeenAddParam(addParam);
    if (addParam === '1') setAddFriendOpen(true);
  }

  const openAddFriend = () => {
    setPeopleQuery('');
    setPeopleResults([]);
    setPeopleSearched(false);
    peopleSequenceRef.current += 1;
    setRequestedIds([]);
    setAddFriendOpen(true);
  };


  const handlePeopleQueryChange = (value: string) => {
    // Search matches names as well as handles and the service is
    // case-insensitive, so send exactly what was typed. Invalidate any
    // in-flight search and clear settled results synchronously here so the
    // debounce effect only schedules fetches.
    peopleSequenceRef.current += 1;
    setPeopleQuery(value);
    if (value.trim().length < 2) {
      setPeopleResults([]);
      setPeopleSearched(false);
    }
  };

  useEffect(() => {
    const normalized = peopleQuery.trim();
    if (!personalRealm || !addFriendOpen || normalized.length < 2) return;
    const sequence = ++peopleSequenceRef.current;
    const timer = setTimeout(() => {
      void searchUsers(normalized).then((results) => {
        if (peopleSequenceRef.current !== sequence) return;
        setPeopleSearched(true);
        setPeopleResults(results ?? []);
      });
    }, PEOPLE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [addFriendOpen, personalRealm, searchUsers, peopleQuery]);

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
  // Consumer accounts list everyone they have chatted with or connected to;
  // anyone else is one "Add a friend" away.
  const consumerPeople = useMemo(
    () => workspace.people.filter((person) => person.connectionState !== 'self'),
    [workspace.people],
  );
  const contactMatches = useMemo(() => {
    const query = contactQuery.trim().toLocaleLowerCase();
    const matches = query
      ? consumerPeople.filter((person) => (
        person.displayName.toLocaleLowerCase().includes(query)
        || (person.username ?? '').toLocaleLowerCase().includes(query)
        || (person.contactAlias ?? '').toLocaleLowerCase().includes(query)
      ))
      : consumerPeople;
    // Saving somebody is now the one thing the star does, so it has to be
    // visible in the list: saved people come first, then everyone else.
    return [...matches].sort((left, right) => {
      if (Boolean(left.favoriteContact) !== Boolean(right.favoriteContact)) {
        return left.favoriteContact ? -1 : 1;
      }
      return personDisplayName(left).localeCompare(personDisplayName(right));
    });
  }, [consumerPeople, contactQuery]);

  const openConversation = (conversationId: string) => {
    if (desktop) {
      router.replace('/');
    } else {
      router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
    }
  };

  const openMessage = async (person: Person) => {
    const conversationId = await workspace.openOrCreateDirectConversation(person.id);
    if (conversationId) openConversation(conversationId);
  };

  const openSearchResult = async (result: UserSearchResult) => {
    const conversationId = await workspace.openOrCreateDirectConversation(result.userId, {
      displayName: result.displayName ?? result.username,
      username: result.username,
    });
    if (conversationId) openConversation(conversationId);
  };

  const openManage = (person: Person) => {
    workspace.clearActionError();
    setContactAlias(person.contactAlias ?? '');
    setReportOpen(false);
    setReportCategory('other');
    setReportDetails('');
    setReportConsent(false);
    setManagePersonId(person.id);
  };

  // A group's member sheet routes here with ?report=<id>, so reporting someone
  // is reachable from the conversation they are in without the chat carrying a
  // second copy of this form.
  if (reportParam !== seenReportParam) {
    setSeenReportParam(reportParam);
    const target = reportParam
      ? workspace.people.find((person) => person.id === reportParam)
      : undefined;
    if (target) {
      openManage(target);
      setReportOpen(true);
    }
  }

  const renderPersonCard = (person: Person) => (
    <PersonCard
      desktop={desktop}
      key={person.id}
      onConnect={() => void workspace.updateConnection(person.id)}
      onDecline={() => setDecliningPersonId(person.id)}
      onAccept={() => void workspace.respondConnection(person.id, 'accepted')}
      onMessage={() => void openMessage(person)}
      onManage={() => openManage(person)}
      onRemove={() => void workspace.removeConnection(person.id)}
      person={person}
    />
  );

  const searchResultPerson = (result: UserSearchResult): Person => {
    const known = workspace.people.find((person) => person.id === result.userId);
    const name = result.displayName ?? result.username;
    return {
      id: result.userId,
      membershipId: result.userId,
      displayName: name,
      username: result.username,
      initials: displayInitials(name),
      roleLabel: `@${result.username}`,
      role: 'employee',
      site: '',
      department: '',
      preferredLanguage: known?.preferredLanguage ?? 'en',
      presence: known?.presence ?? 'offline',
      connectionState: known?.connectionState ?? 'available',
      blockedByMe: known?.blockedByMe,
      avatarColor: known?.avatarColor ?? colors.forest,
    };
  };

  return (
    <AppScaffold
      current="people"
      mobileHeader={
        <MobileBrandHeader
          subtitle={t(personalRealm ? 'people.subtitleConsumer' : 'people.subtitle')}
          title={t(personalRealm ? 'people.contactsTitle' : 'people.title')}
        />
      }>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error'
        || (workspace.people.length <= 1 && !personalRealm) ? (
        <WorkspaceStatePanel resource="people" />
      ) : (
      // Keeps the search field and its first results above the iOS keyboard;
      // taps on results must not be swallowed by keyboard dismissal.
      <KeyboardAvoidingScreen style={styles.keyboard}>
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {/* The consumer wording exists, is translated and is asserted by
            localized-security-copy; gating the whole header on !personalRealm
            meant a consumer saw neither variant. No eyebrow on the consumer
            side: people.eyebrowConsumer already labels the contacts list a few
            lines down, and repeating it is noise. */}
        {desktop ? (
          <DesktopPageHeader
            description={t(personalRealm ? 'people.descriptionConsumer' : 'people.description')}
            eyebrow={personalRealm ? undefined : t('people.eyebrow')}
            title={t(personalRealm ? 'people.contactsTitle' : 'people.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
          {personalRealm ? (
            <View style={styles.consumerSections}>
              <View style={styles.contactTools}>
                <View style={styles.contactSearch}>
                  <SearchField
                    onChangeText={setContactQuery}
                    placeholder={t('people.searchContacts')}
                    testID="people-search"
                    value={contactQuery}
                  />
                </View>
                <IconButton
                  label={t('people.addFriendOpen')}
                  name="person-add-outline"
                  onPress={openAddFriend}
                  tone="accent"
                />
              </View>
              <View style={styles.consumerSection}>
                <Text style={styles.directoryEyebrow}>{t('people.eyebrowConsumer')}</Text>
                {contactMatches.length ? (
                  <View style={styles.rows}>
                    {contactMatches.map((person) => (
                      <PersonRow
                        key={person.id}
                        onManage={() => openManage(person)}
                        onMessage={() => void openMessage(person)}
                        person={person}
                      />
                    ))}
                  </View>
                ) : contactQuery.trim() ? (
                  <Text style={styles.rowsEmpty}>{t('people.noContactMatch')}</Text>
                ) : (
                  <EmptyState
                    body={t('people.emptyConsumerBody')}
                    icon="people-outline"
                    title={t('people.emptyConsumer')}
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
      </KeyboardAvoidingScreen>
      )}
      <ActionModal
        description={t('people.addFriendBody')}
        onClose={() => setAddFriendOpen(false)}
        title={t('people.addFriendTitle')}
        visible={addFriendOpen}>
        <SearchField
          onChangeText={handlePeopleQueryChange}
          placeholder={t('people.usernameSearch')}
          testID="add-friend-search"
          value={peopleQuery}
        />
        {searching ? (
          peopleResults.length ? (
            <View style={styles.rows}>
              {peopleResults.map((result) => {
                const known = workspace.people.find((person) => person.id === result.userId);
                const alreadyAsked = result.connectionState !== 'none'
                  || requestedIds.includes(result.userId)
                  || known?.connectionState === 'connected'
                  || known?.connectionState === 'pending';
                return (
                  <PersonRow
                    key={result.userId}
                    onAdd={alreadyAsked ? undefined : async () => {
                      if (await workspace.updateConnection(result.userId)) {
                        setRequestedIds((current) => [...current, result.userId]);
                      }
                    }}
                    onManage={known ? () => openManage(known) : undefined}
                    onMessage={() => {
                      setAddFriendOpen(false);
                      void openSearchResult(result);
                    }}
                    person={searchResultPerson(result)}
                    requested={alreadyAsked}
                  />
                );
              })}
            </View>
          ) : peopleSearched ? (
            <Text style={styles.rowsEmpty}>{t('people.usernameNoResults')}</Text>
          ) : null
        ) : null}
      </ActionModal>
      <ActionModal
        description={decliningPerson ? t('people.declineConfirmBody').replace('{name}', decliningPerson.displayName) : undefined}
        onClose={() => setDecliningPersonId('')}
        title={t('people.declineConfirmTitle')}
        visible={Boolean(decliningPerson)}>
        <View style={styles.confirmActions}>
          <PrimaryButton
            icon="close"
            label={t('people.declineConfirm')}
            onPress={() => {
              const personId = decliningPersonId;
              setDecliningPersonId('');
              void workspace.respondConnection(personId, 'declined');
            }}
            tone="danger"
          />
          <PrimaryButton label={t('people.keepRequest')} onPress={() => setDecliningPersonId('')} tone="light" />
        </View>
      </ActionModal>
      <ActionModal
        description={personalRealm ? undefined : t('people.manageDescription')}
        onClose={() => setManagePersonId('')}
        title={managePerson ? `${t('people.manageTitle')} · ${personDisplayName(managePerson)}` : t('people.manageTitle')}
        visible={Boolean(managePerson)}>
        {/* The nickname commits when you leave the field: a person who typed
            one and closed the sheet used to lose it to a Save button they
            never pressed. Typing one saves the contact, which is what setting
            a private name for somebody means. */}
        <FormField
          label={t('people.alias')}
          onBlur={() => {
            if (!managePerson) return;
            const next = contactAlias.trim();
            if (next === (managePerson.contactAlias ?? '')) return;
            void workspace.saveContact(managePerson.id, next, managePerson.favoriteContact === true);
          }}
          onChangeText={setContactAlias}
          placeholder={t('people.aliasPlaceholder')}
          value={contactAlias}
        />
        <PrimaryButton
          icon={managePerson?.favoriteContact ? 'star' : 'star-outline'}
          label={t(managePerson?.favoriteContact ? 'people.removeSaved' : 'people.saveContact')}
          loading={workspace.actionBusy === 'contact-save' || workspace.actionBusy === 'contact-remove'}
          onPress={() => {
            if (!managePerson) return;
            // Favouriting keeps whatever you call them; the two are separate.
            void workspace.saveContact(
              managePerson.id,
              contactAlias.trim(),
              !managePerson.favoriteContact,
            );
          }}
          tone={managePerson?.favoriteContact ? 'dark' : 'light'}
        />
        {personalRealm ? null : (
          <View style={styles.privacyNote}>
            <Ionicons name="shield-checkmark-outline" color={colors.inkSubtle} size={17} />
            <Text style={styles.privacyNoteText}>{t('people.blockNotice')}</Text>
          </View>
        )}
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          icon={managePerson?.blockedByMe ? 'shield-checkmark-outline' : 'ban-outline'}
          label={managePerson?.blockedByMe ? t('people.unblock') : t('people.block')}
          loading={workspace.actionBusy === (managePerson?.blockedByMe ? 'person-unblock' : 'person-block')}
          onPress={() => managePerson && void workspace.setPersonBlocked(managePerson.id, !managePerson.blockedByMe)}
          tone={managePerson?.blockedByMe ? 'light' : 'danger'}
        />
        <Pressable
          accessibilityLabel={t('people.reportPrivately')}
          accessibilityRole="button"
          onPress={() => setReportOpen(true)}
          style={({ pressed }) => [styles.reportLink, pressed && styles.reportLinkPressed]}>
          <Text style={styles.reportLinkText}>{t('people.reportPrivately')}</Text>
        </Pressable>
      </ActionModal>
      <ActionModal
        onClose={() => setReportOpen(false)}
        title={managePerson ? `${t('people.reportPrivately')} · ${personDisplayName(managePerson)}` : t('people.reportPrivately')}
        visible={reportOpen && Boolean(managePerson)}>
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
          {personalRealm ? (
            <Text style={styles.reportDisclosureText}>{t('people.reportNoticeConsumer')}</Text>
          ) : (
            <>
              <Text style={styles.reportDisclosureText}>
                {moderationTargetReportConsentNotice(locale, 'member')}
              </Text>
              <Text style={styles.reportRouteText}>
                {moderationMemberSafetyRouteNotice(locale)}
              </Text>
            </>
          )}
          <Pressable
            accessibilityRole="checkbox"
            {...a11yState({ checked: reportConsent })}
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
            <Text style={styles.reportConsentText}>{personalRealm ? t('people.reportConsentConsumer') : safetyCopy.reportConsentLabel}</Text>
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
            )) {
              setReportOpen(false);
              setManagePersonId('');
            }
          }}
          tone="danger"
        />
      </ActionModal>
    </AppScaffold>
  );
}

/**
 * Compact consumer row: avatar, name, @handle, one action. The container is
 * not itself accessible so the button and the manage control stay separate
 * targets for VoiceOver and for the test driver.
 */
function PersonRow({
  person,
  onMessage,
  onManage,
  onAdd,
  requested = false,
}: {
  person: Person;
  onMessage: () => void;
  onManage?: () => void;
  /** Only the add-a-friend sheet offers this; Contacts never does. */
  onAdd?: () => void;
  requested?: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  const personAvatarUrl = useProfileAvatar(person.id);
  const { t } = useI18n();
  return (
    <View accessible={false} style={styles.personRow}>
      <Avatar
        color={person.avatarColor}
        imageUri={personAvatarUrl}
        initials={person.initials}
        size={40}
      />
      <View style={styles.personRowCopy}>
        <Text numberOfLines={1} style={styles.personRowName}>{personDisplayName(person)}</Text>
        {person.username ? (
          <Text numberOfLines={1} style={styles.personRowHandle}>{`@${person.username}`}</Text>
        ) : null}
      </View>
      {person.blockedByMe ? (
        <StatusBadge icon="ban-outline" label={t('people.blocked')} tone="danger" />
      ) : (
        <>
          {onAdd ? (
            <PrimaryButton icon="person-add-outline" label={t('people.addFriendAction')} onPress={onAdd} tone="dark" />
          ) : requested ? (
            <StatusBadge icon="checkmark" label={t('people.addFriendSent')} tone="success" />
          ) : null}
          <PrimaryButton icon="chatbubble-outline" label={t('people.message')} onPress={onMessage} tone="light" />
        </>
      )}
      {onManage ? (
        <IconButton
          accessibilityLabel={`${t('people.manage')} ${personDisplayName(person)}`}
          label={t('people.manage')}
          name="ellipsis-horizontal"
          onPress={onManage}
        />
      ) : null}
    </View>
  );
}

function PersonCard({
  person,
  onConnect,
  onAccept,
  onDecline,
  onMessage,
  onManage,
  onRemove,
  desktop,
}: {
  person: Person;
  onConnect: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onMessage: () => void;
  onManage: () => void;
  onRemove: () => void;
  desktop: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const personAvatarUrl = useProfileAvatar(person.id);
  const { t } = useI18n();
  const connected = person.connectionState === 'connected';
  const pending = person.connectionState === 'pending';
  const manageButton = (
    <IconButton
      accessibilityLabel={`${t('people.manage')} ${personDisplayName(person)}`}
      label={t('people.manage')}
      name="ellipsis-horizontal"
      onPress={onManage}
    />
  );
  return (
    <View style={[styles.personCard, !desktop && styles.personCardMobile, shadow]}>
      <View style={styles.personTopline}>
        <Avatar
          color={person.avatarColor}
          imageUri={personAvatarUrl}
          initials={person.initials}
          presence={person.presence}
          size={52}
        />
        <View style={styles.personStatus}>
          {person.blockedByMe ? <StatusBadge icon="ban-outline" label={t('people.blocked')} tone="danger" /> : null}
          {person.favoriteContact ? <StatusBadge icon="star" label={t('people.saved')} tone="warning" /> : null}
          <StatusBadge
            label={person.preferredLanguage === 'ko' ? '한국어' : person.preferredLanguage === 'es' ? 'Español' : 'English'}
            tone={person.preferredLanguage === 'ko' ? 'purple' : 'warning'}
          />
        </View>
      </View>
      <Text style={styles.personName}>{personDisplayName(person)}</Text>
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
          <PrimaryButton
            accessibilityLabel={`${t('people.manage')} ${personDisplayName(person)}`}
            icon="options-outline"
            label={t('people.manage')}
            onPress={onManage}
            tone="light"
          />
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
            <PrimaryButton
              icon="person-add-outline"
              label={t('people.connect')}
              onPress={onConnect}
              tone="dark"
              style={styles.connectButton}
            />
            {manageButton}
          </>
        )}
      </View>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  keyboard: {
    flex: 1,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
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
    gap: spacing.md,
  },
  contactTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  contactSearch: {
    flex: 1,
    minWidth: 0,
  },
  consumerSection: {
    gap: spacing.xs,
  },
  rows: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    overflow: 'hidden',
  },
  rowsEmpty: {
    color: colors.inkMuted,
    fontSize: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  personRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  personRowCopy: {
    flex: 1,
    minWidth: 0,
  },
  personRowName: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  personRowHandle: {
    color: colors.inkSubtle,
    fontSize: 12,
    marginTop: 1,
  },
  directoryTools: {
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
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
  reportLink: { paddingVertical: spacing.sm, alignItems: 'center' },
  reportLinkPressed: { opacity: 0.6 },
  reportLinkText: { color: colors.inkSubtle, fontSize: 12, textDecorationLine: 'underline' },
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
