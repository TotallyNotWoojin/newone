import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
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
  const safetyCopy = moderationCopy(locale);
  const reportCategoryLabels = {
    harassment: t('chat.reportHarassment'),
    threat: t('chat.reportThreat'),
    spam: t('chat.reportSpam'),
    privacy: t('chat.reportPrivacy'),
    misinformation: t('chat.reportMisinformation'),
    other: t('chat.reportOther'),
  };

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
      if (filter === 'my_site') return person.site === workspace.currentUser.site;
      if (filter === 'pending') return person.connectionState === 'pending';
      return true;
    });
  }, [filter, search, workspace.currentUser.site, workspace.people]);

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

  return (
    <AppScaffold
      current="people"
      mobileHeader={
        <MobileBrandHeader
          subtitle={t('people.subtitle')}
          title={t('people.title')}
        />
      }>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error' || workspace.people.length <= 1 ? (
        <WorkspaceStatePanel resource="people" />
      ) : (
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {desktop ? (
          <DesktopPageHeader
            description={t('people.description')}
            eyebrow={t('people.eyebrow')}
            title={t('people.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
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
              people.map((person) => (
                <PersonCard
                  desktop={desktop}
                  key={person.id}
                  onConnect={() => void workspace.updateConnection(person.id)}
                  onDecline={() => void workspace.respondConnection(person.id, 'declined')}
                  onAccept={() => void workspace.respondConnection(person.id, 'accepted')}
                  onMessage={() => void openMessage(person)}
                  onManage={() => openManage(person)}
                  onRemove={() => void workspace.removeConnection(person.id)}
                  person={person}
                />
              ))
            ) : (
              <EmptyState
                body={t('status.emptyPeopleBody')}
                icon="search-outline"
                title={t('status.emptyPeople')}
              />
            )}
          </View>
        </View>
      </ScrollView>
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
          <Text style={styles.privacyNoteText}>{t('people.blockNotice')}</Text>
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
  const { t } = useI18n();
  const connected = person.connectionState === 'connected';
  const pending = person.connectionState === 'pending';
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
          <StatusBadge
            label={person.preferredLanguage === 'ko' ? '한국어' : person.preferredLanguage === 'es' ? 'Español' : 'English'}
            tone={person.preferredLanguage === 'ko' ? 'purple' : 'warning'}
          />
        </View>
      </View>
      <Text style={styles.personName}>{person.displayName}</Text>
      <Text style={styles.personRole}>{person.roleLabel}</Text>
      <View style={styles.personMetaRow}>
        <Ionicons name="business-outline" size={13} color={colors.inkSubtle} />
        <Text numberOfLines={1} style={styles.personMeta}>{person.site}</Text>
      </View>
      <View style={styles.personMetaRow}>
        <Ionicons name="git-network-outline" size={13} color={colors.inkSubtle} />
        <Text numberOfLines={1} style={styles.personMeta}>{person.department}</Text>
      </View>
      <View style={styles.personActions}>
        {person.blockedByMe ? (
          <PrimaryButton icon="options-outline" label={t('people.manage')} onPress={onManage} tone="light" />
        ) : connected ? (
          <>
            <PrimaryButton icon="chatbubble-outline" label={t('people.message')} onPress={onMessage} />
            <IconButton label={t('people.removeConnection')} name="person-remove-outline" onPress={onRemove} tone="danger" />
            <IconButton label={t('people.manage')} name="ellipsis-horizontal" onPress={onManage} />
          </>
        ) : pending && person.connectionRequestDirection === 'incoming' ? (
          <>
            <PrimaryButton icon="checkmark" label={t('people.accept')} onPress={onAccept} tone="dark" />
            <PrimaryButton icon="close" label={t('people.decline')} onPress={onDecline} tone="light" />
            <IconButton label={t('people.manage')} name="ellipsis-horizontal" onPress={onManage} />
          </>
        ) : pending ? (
          <>
            <PrimaryButton icon="close" label={t('people.cancelRequest')} onPress={onRemove} tone="light" />
            <IconButton label={t('people.manage')} name="ellipsis-horizontal" onPress={onManage} />
          </>
        ) : (
          <>
            <PrimaryButton
              disabled={pending}
              icon={pending ? 'time-outline' : 'person-add-outline'}
              label={pending ? t('people.requestPending') : t('people.connect')}
              onPress={onConnect}
              tone={pending ? 'light' : 'dark'}
              style={styles.connectButton}
            />
            <IconButton label={t('people.manage')} name="ellipsis-horizontal" onPress={onManage} />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
