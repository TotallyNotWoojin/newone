import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DesktopPageHeader } from '@/components/navigation/app-scaffold';
import { KeyboardAvoidingScreen } from '@/components/ui/keyboard-avoiding-screen';
import { Avatar, Chip, EmptyState, PrimaryButton, SearchField } from '@/components/ui/primitives';
import { BffSearchRepository } from '@/data/repositories/bff-search-repository';
import { RepositoryError, type UserSearchResult } from '@/data/repositories/contracts';
import {
  mergeSearchResults,
  searchDateBoundary,
  searchLanguages,
  searchMessageMatchSources,
} from '@/data/search-contract.mjs';
import type {
  SearchLanguageFilter,
  SearchMessageMatchSource,
  SearchResultType,
  WorkspaceSearchResult,
} from '@/domain/types';
import { searchCopy } from '@/features/search/search-copy';
import { useI18n } from '@/i18n/provider';
import { errorMessageKey } from '@/i18n/errors';
import { getSupabaseClient } from '@/lib/supabase';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useKeyboardAppearance, useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

const allTypes: SearchResultType[] = [
  'people',
  'conversations',
  'messages',
  'announcements',
  'handoffs',
];

const CONSUMER_SEARCH_DEBOUNCE_MS = 350;

function displayInitials(displayName: string) {
  return displayName.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toLocaleUpperCase() || 'N';
}

/**
 * The full search with its filters — sender, language, calendar, which field
 * matched — kept for workspace organizations, now opened from the Chats field
 * instead of a tab of its own.
 */
export function WorkspaceSearchPanel({
  initialQuery = '',
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const keyboardAppearance = useKeyboardAppearance();
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const copy = searchCopy(locale);
  const [query, setQuery] = useState(initialQuery);
  const [selectedType, setSelectedType] = useState<SearchResultType | 'all'>('all');
  const [selectedSource, setSelectedSource] = useState<SearchMessageMatchSource | 'all'>('all');
  const [selectedSenderId, setSelectedSenderId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<SearchLanguageFilter | 'all'>('all');
  const [dateFromInput, setDateFromInput] = useState('');
  const [dateToInput, setDateToInput] = useState('');
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastFingerprint, setLastFingerprint] = useState('');
  const [resultsAuthorizationSignature, setResultsAuthorizationSignature] = useState('');
  const requestGeneration = useRef(0);
  const personalRealm = isPersonalRealm(workspace.organizationId);
  // Consumer search also finds people, through the same search as the People
  // tab, and runs as you type.
  const [peopleResults, setPeopleResults] = useState<UserSearchResult[]>([]);
  const [peopleSearched, setPeopleSearched] = useState(false);
  const peopleSequence = useRef(0);
  const searchUsers = workspace.searchUsers;
  const runSearchRef = useRef<(append?: boolean) => Promise<void>>(async () => undefined);

  const repository = useMemo(
    () => new BffSearchRepository({
      getSession: async () => {
        const client = getSupabaseClient();
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data.session;
      },
    }),
    [],
  );
  const senders = useMemo(
    () => workspace.people.filter((person) => !person.suspended),
    [workspace.people],
  );
  const managementOnlyConversationIds = useMemo(
    () => new Set(workspace.conversations
      .filter((conversation) => conversation.managementOnly)
      .map((conversation) => conversation.id)),
    [workspace.conversations],
  );
  const conversationAuthorizationSignature = useMemo(
    () => workspace.conversations
      .map((conversation) => `${conversation.id}:${conversation.managementOnly ? 'management' : 'member'}`)
      .sort()
      .join('|'),
    [workspace.conversations],
  );
  const managementOnlyConversationSignature = useMemo(
    () => [...managementOnlyConversationIds].sort().join('|'),
    [managementOnlyConversationIds],
  );
  const managementOnlyConversationIdsRef = useRef(managementOnlyConversationIds);
  const conversationAuthorizationSignatureRef = useRef(conversationAuthorizationSignature);
  // A one-to-one chat with somebody the People section already lists is the
  // same row twice; the person's own row opens that chat anyway (v3.4).
  const peopleResultIds = new Set(peopleResults.map((person) => person.userId));
  const duplicateDirectIds = new Set(
    workspace.conversations
      .filter((conversation) => conversation.kind === 'direct'
        && conversation.directParticipantId
        && peopleResultIds.has(conversation.directParticipantId))
      .map((conversation) => conversation.id),
  );
  const visibleResults = resultsAuthorizationSignature === conversationAuthorizationSignature
    ? results.filter((result) => (
        (!result.conversationId || !managementOnlyConversationIds.has(result.conversationId))
        && !(personalRealm && result.type === 'conversations' && duplicateDirectIds.has(result.id))
      ))
    : [];

  const resetResults = () => {
    requestGeneration.current += 1;
    setResults([]);
    setNextCursor(null);
    setHasMore(false);
    setSearched(false);
    setError('');
    setLastFingerprint('');
    setResultsAuthorizationSignature('');
  };

  useEffect(() => {
    conversationAuthorizationSignatureRef.current = conversationAuthorizationSignature;
    managementOnlyConversationIdsRef.current = new Set(
      managementOnlyConversationSignature ? managementOnlyConversationSignature.split('|') : [],
    );
    requestGeneration.current += 1;
    const timeout = setTimeout(() => {
      setResults([]);
      setNextCursor(null);
      setHasMore(false);
      setSearched(false);
      setLoading(false);
      setError('');
      setLastFingerprint('');
      setResultsAuthorizationSignature('');
      setSelectedConversationId((current) => (
        current && managementOnlyConversationIdsRef.current.has(current) ? null : current
      ));
    }, 0);
    return () => clearTimeout(timeout);
  }, [conversationAuthorizationSignature, managementOnlyConversationSignature]);

  const calendarRange = () => {
    let dateFrom: string | null;
    let dateTo: string | null;
    try {
      dateFrom = searchDateBoundary(dateFromInput, 'start');
      dateTo = searchDateBoundary(dateToInput, 'end');
    } catch {
      throw new Error(copy.invalidDate);
    }
    if (
      dateFrom && dateTo && (
        dateFrom > dateTo ||
        Date.parse(dateTo) - Date.parse(dateFrom) > 10 * 366 * 24 * 60 * 60 * 1000
      )
    ) throw new Error(copy.invalidDateRange);
    return { dateFrom, dateTo };
  };

  const fingerprint = [
    query.trim(),
    selectedType,
    selectedSource,
    selectedSenderId ?? '',
    selectedConversationId ?? '',
    selectedLanguage,
    dateFromInput,
    dateToInput,
  ].join('\u001f');

  const runSearch = async (append = false) => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setError(t('search.validation'));
      return;
    }
    let dateFrom: string | null;
    let dateTo: string | null;
    try {
      ({ dateFrom, dateTo } = calendarRange());
    } catch (dateError) {
      setError(dateError instanceof Error ? dateError.message : copy.invalidDate);
      return;
    }
    if (append && fingerprint !== lastFingerprint) {
      setError(t('search.error'));
      return;
    }
    if (append && resultsAuthorizationSignature !== conversationAuthorizationSignature) return;
    if (
      selectedConversationId
      && managementOnlyConversationIdsRef.current.has(selectedConversationId)
    ) return;
    const generation = ++requestGeneration.current;
    const authorizationAtRequest = conversationAuthorizationSignatureRef.current;
    setLoading(true);
    setError('');
    try {
      const page = await repository.search({
        organizationId: workspace.organizationId,
        query: normalized,
        types: personalRealm
          ? ['conversations', 'messages']
          : selectedType === 'all' ? undefined : [selectedType],
        cursor: append ? nextCursor : null,
        limit: 20,
        senderMembershipId: selectedSenderId,
        dateFrom,
        dateTo,
        // Searching "echo" should find messages with "echo" in them, not every
        // message an account called Echo ever sent — and the sender match also
        // put the sender's name in the result's own snippet, so the rows read
        // as a name twice over (owner, Sep 8 2026).
        matchSources: selectedSource === 'all'
          ? (personalRealm ? ['original', 'translation', 'attachment_filename'] : null)
          : [selectedSource],
        conversationId: selectedConversationId,
        language: selectedLanguage === 'all' ? null : selectedLanguage,
      });
      if (
        generation !== requestGeneration.current
        || authorizationAtRequest !== conversationAuthorizationSignatureRef.current
      ) return;
      setResults((current) => append
        ? mergeSearchResults(current, page.results)
        : page.results);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLastFingerprint(fingerprint);
      setResultsAuthorizationSignature(authorizationAtRequest);
      setSearched(true);
    } catch (searchError) {
      if (generation !== requestGeneration.current) return;
      setError(searchError instanceof RepositoryError
        ? t(errorMessageKey(searchError))
        : t('search.error'));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    runSearchRef.current = runSearch;
  });

  useEffect(() => {
    if (!personalRealm) return;
    const normalized = query.trim();
    if (normalized.length < 2) return;
    const sequence = ++peopleSequence.current;
    const timer = setTimeout(() => {
      void searchUsers(normalized).then((results) => {
        if (peopleSequence.current !== sequence) return;
        setPeopleResults(results ?? []);
        setPeopleSearched(true);
      });
      void runSearchRef.current(false);
    }, CONSUMER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [personalRealm, query, searchUsers]);

  const openPerson = async (result: UserSearchResult) => {
    const conversationId = await workspace.openOrCreateDirectConversation(result.userId, {
      displayName: result.displayName ?? result.username,
      username: result.username,
    });
    if (!conversationId) return;
    onClose();
    if (desktop) workspace.selectConversation(conversationId);
    else router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
  };

  const openResult = (result: WorkspaceSearchResult) => {
    if (
      resultsAuthorizationSignature !== conversationAuthorizationSignature
      || (result.conversationId && managementOnlyConversationIds.has(result.conversationId))
    ) {
      resetResults();
      return;
    }
    if (result.type === 'messages' && result.conversationId) {
      workspace.selectConversation(result.conversationId);
      onClose();
      router.push({
        pathname: '/conversation/[id]',
        params: { id: result.conversationId, messageId: result.id },
      });
      return;
    }
    if (result.type === 'conversations' && result.conversationId) {
      workspace.selectConversation(result.conversationId);
      onClose();
      router.push({ pathname: '/conversation/[id]', params: { id: result.conversationId } });
      return;
    }
    onClose();
    if (result.type === 'people') router.replace('/people');
    if (result.type === 'announcements') router.replace('/updates');
    if (result.type === 'handoffs') router.replace('/handoffs');
  };

  const selectType = (typeName: SearchResultType | 'all') => {
    setSelectedType(typeName);
    if (typeName !== 'messages') {
      setSelectedSource('all');
      setSelectedSenderId(null);
    }
    resetResults();
  };
  const selectSource = (source: SearchMessageMatchSource | 'all') => {
    setSelectedSource(source);
    if (source !== 'all') setSelectedType('messages');
    resetResults();
  };
  const selectSender = (senderId: string | null) => {
    setSelectedSenderId(senderId);
    if (senderId) setSelectedType('messages');
    resetResults();
  };
  const selectConversation = (conversationId: string | null) => {
    setSelectedConversationId(conversationId);
    resetResults();
  };
  const selectLanguage = (language: SearchLanguageFilter | 'all') => {
    setSelectedLanguage(language);
    resetResults();
  };
  const clearFilters = () => {
    setSelectedType('all');
    setSelectedSource('all');
    setSelectedSenderId(null);
    setSelectedConversationId(null);
    setSelectedLanguage('all');
    setDateFromInput('');
    setDateToInput('');
    resetResults();
  };

  const typeLabels: Record<SearchResultType | 'all', string> = {
    all: t('search.all'),
    people: t('search.people'),
    conversations: t('search.conversations'),
    messages: t('search.messages'),
    announcements: t('search.announcements'),
    handoffs: t('search.handoffs'),
  };
  const hasFilters = selectedType !== 'all' || selectedSource !== 'all' ||
    selectedSenderId !== null || selectedConversationId !== null || selectedLanguage !== 'all' ||
    dateFromInput !== '' || dateToInput !== '';
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t('search.title')}</Text>
        <Pressable
          accessibilityLabel={t('search.closeFilters')}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [styles.panelClose, pressed && styles.pressed]}>
          <Ionicons color={colors.ink} name="close" size={20} />
        </Pressable>
      </View>
      {/* Keeps the query field and the first results above the iOS keyboard;
          result taps must not be swallowed by keyboard dismissal. */}
      <KeyboardAvoidingScreen style={styles.keyboard}>
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled">
        {desktop && !personalRealm ? (
          <DesktopPageHeader
            description={t('search.description')}
            eyebrow={t('search.eyebrow')}
            title={t('search.heading')}
          />
        ) : null}
        <View style={[styles.content, shadow]}>
          <View style={[styles.searchRow, !desktop && styles.searchRowMobile]}>
            <View style={styles.searchField}>
              <SearchField
                clearLabel={t('common.clearSearch')}
                onChangeText={(value) => {
                  setQuery(value);
                  resetResults();
                  // Invalidate any in-flight people search; the debounce effect
                  // only schedules fetches for a real query.
                  peopleSequence.current += 1;
                  if (value.trim().length < 2) {
                    setPeopleResults([]);
                    setPeopleSearched(false);
                  }
                }}
                onSubmitEditing={() => void runSearch(false)}
                placeholder={t(personalRealm ? 'search.placeholderPeopleMessages' : 'search.placeholder')}
                value={query}
              />
            </View>
            {personalRealm ? null : (
              <PrimaryButton
                icon="search"
                label={t('search.submit')}
                loading={loading}
                onPress={() => void runSearch(false)}
              />
            )}
          </View>

          {personalRealm ? null : (
          <View accessibilityLabel={copy.filters} style={styles.filterPanel}>
            <View style={styles.filterHeadingRow}>
              <View style={styles.filterHeadingCopy}>
                <Text style={styles.filterHeading}>{copy.filters}</Text>
                <Text style={styles.filterDescription}>{copy.filtersDescription}</Text>
              </View>
              {hasFilters ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={clearFilters}
                  style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}>
                  <Text style={styles.clearButtonText}>{copy.clearFilters}</Text>
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.filterLabel}>{t('search.all')}</Text>
            <ScrollView horizontal contentContainerStyle={styles.filters} showsHorizontalScrollIndicator={false}>
              {(['all', ...allTypes] as const).map((typeName) => (
                <Chip
                  key={typeName}
                  label={typeLabels[typeName]}
                  onPress={() => selectType(typeName)}
                  selected={selectedType === typeName}
                />
              ))}
            </ScrollView>

            <Text style={styles.filterLabel}>{copy.conversation}</Text>
            <ScrollView horizontal contentContainerStyle={styles.filters} showsHorizontalScrollIndicator={false}>
              <Chip
                label={copy.anyConversation}
                onPress={() => selectConversation(null)}
                selected={selectedConversationId === null}
              />
              {workspace.conversations.filter((conversation) => !conversation.managementOnly).map((conversation) => (
                <Chip
                  key={conversation.id}
                  label={conversation.title}
                  onPress={() => selectConversation(conversation.id)}
                  selected={selectedConversationId === conversation.id}
                />
              ))}
            </ScrollView>

            <Text style={styles.filterLabel}>{copy.language}</Text>
            <ScrollView horizontal contentContainerStyle={styles.filters} showsHorizontalScrollIndicator={false}>
              <Chip
                label={copy.anyLanguage}
                onPress={() => selectLanguage('all')}
                selected={selectedLanguage === 'all'}
              />
              {(searchLanguages as readonly SearchLanguageFilter[]).map((language) => (
                <Chip
                  key={language}
                  label={copy.languageLabels[language]}
                  onPress={() => selectLanguage(language)}
                  selected={selectedLanguage === language}
                />
              ))}
            </ScrollView>

            <Text style={styles.filterLabel}>{copy.matchIn}</Text>
            <ScrollView horizontal contentContainerStyle={styles.filters} showsHorizontalScrollIndicator={false}>
              <Chip
                label={copy.anyMessageField}
                onPress={() => selectSource('all')}
                selected={selectedSource === 'all'}
              />
              {(searchMessageMatchSources as readonly SearchMessageMatchSource[]).map((source) => (
                <Chip
                  key={source}
                  label={copy.sourceLabels[source]}
                  onPress={() => selectSource(source)}
                  selected={selectedSource === source}
                />
              ))}
            </ScrollView>

            <Text style={styles.filterLabel}>{copy.sender}</Text>
            <ScrollView horizontal contentContainerStyle={styles.filters} showsHorizontalScrollIndicator={false}>
              <Chip
                label={copy.anySender}
                onPress={() => selectSender(null)}
                selected={selectedSenderId === null}
              />
              {senders.map((person) => (
                <Chip
                  key={person.id}
                  label={person.displayName}
                  onPress={() => selectSender(person.id)}
                  selected={selectedSenderId === person.id}
                />
              ))}
            </ScrollView>

            <View style={[styles.dateRow, !desktop && styles.dateRowMobile]}>
              <View style={styles.dateField}>
                <Text style={styles.filterLabel}>{copy.fromDate}</Text>
                <TextInput
                  keyboardAppearance={keyboardAppearance}
                  accessibilityHint={copy.dateHint}
                  accessibilityLabel={copy.fromDate}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                  onChangeText={(value) => {
                    setDateFromInput(value);
                    resetResults();
                  }}
                  placeholder={copy.datePlaceholder}
                  placeholderTextColor={colors.inkSubtle}
                  style={styles.dateInput}
                  value={dateFromInput}
                />
              </View>
              <View style={styles.dateField}>
                <Text style={styles.filterLabel}>{copy.toDate}</Text>
                <TextInput
                  keyboardAppearance={keyboardAppearance}
                  accessibilityHint={copy.dateHint}
                  accessibilityLabel={copy.toDate}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                  onChangeText={(value) => {
                    setDateToInput(value);
                    resetResults();
                  }}
                  placeholder={copy.datePlaceholder}
                  placeholderTextColor={colors.inkSubtle}
                  style={styles.dateInput}
                  value={dateToInput}
                />
              </View>
            </View>
            <Text style={styles.dateHint}>{copy.dateHint}</Text>
            {(selectedSource !== 'all' || selectedSenderId !== null) ? (
              <Text accessibilityLiveRegion="polite" style={styles.filterNotice}>
                {copy.messageFilterNotice}
              </Text>
            ) : null}
          </View>
          )}

          {personalRealm && (peopleResults.length || peopleSearched) ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t('search.people')}</Text>
              {peopleResults.length ? (
                <View accessibilityRole="list" style={styles.personRows}>
                  {peopleResults.map((result) => (
                    <PersonResultRow
                      key={result.userId}
                      onMessage={() => void openPerson(result)}
                      result={result}
                    />
                  ))}
                </View>
              ) : (
                <Text style={styles.sectionEmpty}>{t('people.usernameNoResults')}</Text>
              )}
            </View>
          ) : null}
          {personalRealm && (searched || loading) ? (
            <Text style={styles.sectionLabel}>{t('search.messages')}</Text>
          ) : null}

          {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
          {loading && !visibleResults.length ? <ActivityIndicator color={colors.mintDark} style={styles.loader} /> : null}
          {!loading && searched && !visibleResults.length ? (
            personalRealm
              ? <Text style={styles.sectionEmpty}>{t('search.noMatchesConsumer')}</Text>
              : <EmptyState icon="search-outline" title={t('search.empty')} body={t('search.emptyBody')} />
          ) : null}
          {!searched && !loading ? (
            personalRealm
              ? (query.trim().length < 2
                ? <Text style={styles.startHint}>{t('search.startHint')}</Text>
                : null)
              : <EmptyState icon="shield-checkmark-outline" title={t('search.privateTitle')} body={t('search.privateBody')} />
          ) : null}
          <View accessibilityRole="list" style={styles.results}>
            {visibleResults.map((result) => (
              <Pressable
                accessibilityLabel={copy.openResult(result.title)}
                accessibilityRole="button"
                key={`${result.type}-${result.id}`}
                onPress={() => openResult(result)}
                style={({ pressed }) => [styles.result, pressed && styles.pressed]}>
                <View style={styles.resultIcon}>
                  <Ionicons
                    color={colors.mintDark}
                    name={result.type === 'people' ? 'person-outline' : result.type === 'announcements' ? 'megaphone-outline' : result.type === 'handoffs' ? 'swap-horizontal-outline' : result.type === 'messages' ? 'chatbubble-outline' : 'people-outline'}
                    size={19}
                  />
                </View>
                <View style={styles.resultCopy}>
                  {personalRealm ? null : <Text style={styles.resultType}>{typeLabels[result.type]}</Text>}
                  {/* A message result leads with what was said; the name of
                      whoever said it is the second line, not the first. */}
                  {personalRealm && result.type === 'messages' && result.snippet ? (
                    <>
                      <Text numberOfLines={2} style={styles.resultTitle}>{result.snippet}</Text>
                      <Text numberOfLines={1} style={styles.resultSnippet}>{result.title}</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.resultTitle}>{result.title}</Text>
                      {result.snippet ? <Text numberOfLines={2} style={styles.resultSnippet}>{result.snippet}</Text> : null}
                    </>
                  )}
                  <View style={styles.resultMetadata}>
                    {personalRealm ? null : (
                      <Text style={styles.resultMatch}>
                        {copy.resultMatchLabels[result.matchedSource]}
                        {result.matchedLanguage ? ` · ${result.matchedLanguage.toLocaleUpperCase()}` : ''}
                      </Text>
                    )}
                    <Text style={styles.resultTime}>
                      {dateFormatter.format(new Date(result.occurredAt))}
                    </Text>
                  </View>
                </View>
                <Ionicons color={colors.inkSubtle} name="chevron-forward" size={18} />
              </Pressable>
            ))}
          </View>
          {hasMore && nextCursor && fingerprint === lastFingerprint
            && resultsAuthorizationSignature === conversationAuthorizationSignature ? (
            <PrimaryButton
              label={t('search.loadMore')}
              loading={loading}
              onPress={() => void runSearch(true)}
              tone="light"
            />
          ) : null}
        </View>
      </ScrollView>
      </KeyboardAvoidingScreen>
    </View>
  );
}

/**
 * Compact people result: avatar, name, @handle, one Message button. The
 * container is not itself accessible so the button stays its own target.
 */
function PersonResultRow({
  result,
  onMessage,
}: {
  result: UserSearchResult;
  onMessage: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const avatarUrl = useProfileAvatar(result.userId);
  const name = result.displayName ?? result.username;
  return (
    <View accessible={false} style={styles.personRow}>
      <Avatar color={colors.forest} imageUri={avatarUrl} initials={displayInitials(name)} size={40} />
      <View style={styles.personCopy}>
        <Text numberOfLines={1} style={styles.personName}>{name}</Text>
        <Text numberOfLines={1} style={styles.personHandle}>{`@${result.username}`}</Text>
      </View>
      <PrimaryButton icon="chatbubble-outline" label={t('people.message')} onPress={onMessage} tone="light" />
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  keyboard: { flex: 1 },
  panel: { flex: 1, backgroundColor: colors.canvas },
  panelHeader: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
    backgroundColor: colors.paper,
  },
  panelTitle: { color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '800' },
  panelClose: { padding: spacing.xs },
  section: { gap: spacing.xs },
  sectionLabel: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  sectionEmpty: { color: colors.inkMuted, fontSize: 12, paddingVertical: spacing.xs },
  startHint: { color: colors.inkSubtle, fontSize: 13, textAlign: 'center', paddingVertical: spacing.xl },
  personRows: { gap: spacing.xs },
  personRow: {
    minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  personCopy: { flex: 1, minWidth: 0 },
  personName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  personHandle: { color: colors.inkSubtle, fontSize: 12, marginTop: 1 },
  page: { flexGrow: 1, paddingBottom: spacing.xxxl },
  pageMobile: { padding: spacing.md, paddingBottom: 100 },
  content: {
    width: '100%', maxWidth: 960, alignSelf: 'center', gap: spacing.md,
    padding: spacing.lg, borderRadius: radii.lg, borderWidth: 1,
    borderColor: colors.line, backgroundColor: colors.paper,
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchRowMobile: { alignItems: 'stretch', flexDirection: 'column' },
  searchField: { flex: 1, minWidth: 0 },
  filterPanel: {
    gap: spacing.sm, padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.paperMuted, borderColor: colors.line, borderWidth: 1,
  },
  filterHeadingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  filterHeadingCopy: { flex: 1, minWidth: 0 },
  filterHeading: { color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '800' },
  filterDescription: { color: colors.inkMuted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  filterLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  filters: { gap: spacing.xs },
  clearButton: { minHeight: 34, justifyContent: 'center', paddingHorizontal: spacing.sm },
  clearButtonText: { color: colors.mintDark, fontSize: 12, fontWeight: '800' },
  dateRow: { flexDirection: 'row', gap: spacing.sm },
  dateRowMobile: { flexDirection: 'column' },
  dateField: { flex: 1, gap: 6 },
  dateInput: {
    minHeight: 44, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.paper, color: colors.ink, paddingHorizontal: spacing.sm,
    fontSize: 15,
  },
  dateHint: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  filterNotice: {
    color: colors.mintDark, fontSize: 12, lineHeight: 17, fontWeight: '700',
    paddingTop: spacing.xs,
  },
  error: { color: colors.red, fontSize: 13, fontWeight: '700' },
  loader: { marginVertical: spacing.xl },
  results: { gap: spacing.xs },
  result: {
    minHeight: 84, flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.paperMuted,
  },
  resultIcon: {
    width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  resultCopy: { flex: 1, minWidth: 0 },
  resultType: { color: colors.mintDark, fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  resultTitle: { color: colors.ink, fontFamily: type.display, fontSize: 16, fontWeight: '800' },
  resultSnippet: { color: colors.inkMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  resultMetadata: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs,
    marginTop: spacing.xs,
  },
  resultMatch: { color: colors.mintDark, fontSize: 11, fontWeight: '700' },
  resultTime: { color: colors.inkSubtle, fontSize: 11 },
  pressed: { opacity: 0.7 },
});
