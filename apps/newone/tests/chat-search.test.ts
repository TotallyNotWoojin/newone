import { describe, expect, test } from '@jest/globals';

import {
  addPersonToSearch,
  buildSearchSuggestions,
  conversationMatchesSearch,
  conversationParticipantIds,
  findSearchPerson,
  isGroupConversation,
  parseSearch,
  personMatchesNeedle,
  removeChipFromSearch,
  suggestionNeedle,
  type SearchConversationRef,
  type SearchPersonRef,
} from '@/features/search/chat-search';

const ana: SearchPersonRef = { id: 'person-ana', displayName: 'Ana Ruiz', username: 'ana_r' };
const ben: SearchPersonRef = { id: 'person-ben', displayName: 'Ben Cole', username: 'bencole' };
const cora: SearchPersonRef = { id: 'person-cora', displayName: 'Cora Lin', username: null };
const people = [ana, ben, cora];

const beachTrip: SearchConversationRef = {
  id: 'conversation-beach',
  title: 'Beach trip',
  kind: 'group',
  subtitle: '3 people',
  lastMessage: 'Bring the umbrella',
  memberIds: ['person-me', 'person-ana', 'person-ben'],
};
const directAna: SearchConversationRef = {
  id: 'conversation-ana',
  title: 'Ana Ruiz',
  kind: 'direct',
  subtitle: '@ana_r',
  lastMessage: 'See you at six',
  memberIds: [],
  directParticipantId: 'person-ana',
};
const directBen: SearchConversationRef = {
  id: 'conversation-ben',
  title: 'Ben Cole',
  kind: 'direct',
  lastMessage: 'Sent the photos',
  directParticipantId: 'person-ben',
};
const managed: SearchConversationRef = {
  id: 'conversation-managed',
  title: 'Ana Ruiz review',
  kind: 'group',
  managementOnly: true,
  memberIds: ['person-ana'],
};
const conversations = [beachTrip, directAna, directBen, managed];

describe('parsing the one search field', () => {
  test('finished parts become chips and the tail stays as the draft', () => {
    const parsed = parseSearch('Ana Ruiz, Ben Cole, beac', people);

    expect(parsed.chips).toEqual([
      { index: 0, label: 'Ana Ruiz', personId: 'person-ana' },
      { index: 1, label: 'Ben Cole', personId: 'person-ben' },
    ]);
    expect(parsed.personIds).toEqual(['person-ana', 'person-ben']);
    expect(parsed.draft).toBe('beac');
    expect(parsed.terms).toEqual(['beac']);
    expect(parsed.empty).toBe(false);
  });

  test('a handle, any case, and a stray comma all resolve to the same person once', () => {
    const parsed = parseSearch('@ANA_R,, ana ruiz, ', people);

    expect(parsed.chips.map((chip) => chip.personId)).toEqual(['person-ana', 'person-ana']);
    expect(parsed.personIds).toEqual(['person-ana']);
    expect(parsed.draft).toBe('');
    expect(parsed.terms).toEqual([]);
  });

  test('a part matching nobody stays a loose word', () => {
    const parsed = parseSearch('Ana Ruiz, umbrella, pho', people);

    expect(parsed.personIds).toEqual(['person-ana']);
    expect(parsed.terms).toEqual(['umbrella', 'pho']);
    expect(parsed.chips[1]).toEqual({ index: 1, label: 'umbrella', personId: null });
  });

  test('an empty field parses as empty and finds nobody', () => {
    const parsed = parseSearch('  ', people);

    expect(parsed.empty).toBe(true);
    expect(findSearchPerson('   ', people)).toBeNull();
    expect(findSearchPerson('nobody', people)).toBeNull();
    expect(findSearchPerson('Cora Lin', people)).toBe(cora);
  });
});

describe('editing the field by tapping', () => {
  test('tapping a suggestion replaces what was typed and writes the comma', () => {
    expect(addPersonToSearch('', 'Ana Ruiz')).toBe('Ana Ruiz, ');
    expect(addPersonToSearch('Ana Ruiz, be', 'Ben Cole')).toBe('Ana Ruiz, Ben Cole, ');
    expect(addPersonToSearch('   ', '   ')).toBe('');
  });

  test('typed names with commas land in the same place as tapped ones', () => {
    const tapped = parseSearch(
      addPersonToSearch(addPersonToSearch('', 'Ana Ruiz'), 'Ben Cole'),
      people,
    );
    const typed = parseSearch('ana ruiz, ben cole, ', people);

    expect(tapped.personIds).toEqual(typed.personIds);
    expect(tapped.draft).toBe(typed.draft);
  });

  test('one tap clears a chip and leaves the rest of the field alone', () => {
    expect(removeChipFromSearch('Ana Ruiz, Ben Cole, beac', 0)).toBe('Ben Cole, beac');
    expect(removeChipFromSearch('Ana Ruiz, Ben Cole, beac', 1)).toBe('Ana Ruiz, beac');
    expect(removeChipFromSearch('Ana Ruiz, ', 0)).toBe('');
    expect(removeChipFromSearch('Ana Ruiz, beac', 5)).toBe('Ana Ruiz, beac');
    expect(removeChipFromSearch('Ana Ruiz, beac', -1)).toBe('Ana Ruiz, beac');
  });
});

describe('what the chips select', () => {
  test('two people show the conversations containing both, which finds the group', () => {
    const parsed = parseSearch('Ana Ruiz, Ben Cole, ', people);
    const matched = conversations.filter((item) => conversationMatchesSearch(item, parsed));

    expect(matched.map((item) => item.id)).toEqual(['conversation-beach']);
  });

  test('one person shows their direct chat and every group they are in', () => {
    const parsed = parseSearch('Ana Ruiz, ', people);
    const matched = conversations.filter((item) => conversationMatchesSearch(item, parsed));

    expect(matched.map((item) => item.id)).toEqual(['conversation-beach', 'conversation-ana']);
  });

  test('a group name matches directly and management shells never surface', () => {
    const parsed = parseSearch('beach', people);
    expect(conversations.filter((item) => conversationMatchesSearch(item, parsed))
      .map((item) => item.id)).toEqual(['conversation-beach']);
    expect(conversationMatchesSearch(managed, parseSearch('Ana Ruiz, ', people))).toBe(false);
  });

  test('chips plus a word mean those people containing that word', () => {
    const withPreviewWord = parseSearch('Ana Ruiz, Ben Cole, umbrella', people);
    const withMessageWord = parseSearch('Ana Ruiz, Ben Cole, sandcastle', people);

    expect(conversationMatchesSearch(beachTrip, withPreviewWord)).toBe(true);
    expect(conversationMatchesSearch(beachTrip, withMessageWord)).toBe(false);
    // The word lives inside the conversation, which the server's message
    // search answers; the row still belongs in the list.
    expect(conversationMatchesSearch(beachTrip, withMessageWord, new Set(['conversation-beach'])))
      .toBe(true);
  });

  test('an empty field keeps every conversation and participants include the direct partner', () => {
    expect(conversationMatchesSearch(beachTrip, parseSearch('', people))).toBe(true);
    expect([...conversationParticipantIds(directAna)]).toEqual(['person-ana']);
    expect(isGroupConversation(beachTrip)).toBe(true);
    expect(isGroupConversation(directAna)).toBe(false);
    expect(isGroupConversation({ id: 'x', title: 'x' })).toBe(false);
  });
});

describe('suggestion order', () => {
  const messages = [
    {
      id: 'message-1',
      conversationId: 'conversation-beach',
      title: 'Beach trip',
      snippet: 'Ana brought the umbrella',
      occurredAt: '2026-09-01T10:00:00Z',
    },
    { id: 'message-2', conversationId: 'conversation-managed', title: 'Hidden', snippet: 'no' },
  ];

  test('people come first, then chats and groups, then messages', () => {
    const parsed = parseSearch('an', people);
    const suggestions = buildSearchSuggestions({
      parsed,
      people,
      conversations,
      messages,
    });

    expect(suggestions.map((item) => item.kind)).toEqual([
      'person',
      'conversation',
      'conversation',
      'message',
    ]);
    expect(suggestions[0]).toMatchObject({ personId: 'person-ana', known: true, subtitle: '@ana_r' });
    expect(suggestions.at(-1)).toMatchObject({
      conversationId: 'conversation-beach',
      messageId: 'message-1',
    });
  });

  test('strangers follow the people already known and duplicates are dropped', () => {
    const parsed = parseSearch('ben', people);
    const suggestions = buildSearchSuggestions({
      parsed,
      people,
      strangers: [
        { id: 'person-ben', displayName: 'Ben Cole', username: 'bencole' },
        { id: 'person-bea', displayName: 'Bea Nolan', username: 'ben_nolan' },
      ],
      conversations: [],
    });

    expect(suggestions.map((item) => item.kind === 'person' && [item.personId, item.known]))
      .toEqual([['person-ben', true], ['person-bea', false]]);
  });

  test('a person already chipped is not suggested again and limits are honoured', () => {
    const parsed = parseSearch('Ana Ruiz, an', people);
    const suggestions = buildSearchSuggestions({
      parsed,
      people,
      conversations,
      limits: { conversations: 1 },
    });

    expect(suggestions.some((item) => item.kind === 'person')).toBe(false);
    expect(suggestions.filter((item) => item.kind === 'conversation')).toHaveLength(1);
  });

  test('an empty field suggests nothing at all', () => {
    expect(buildSearchSuggestions({ parsed: parseSearch('', people), people, conversations }))
      .toEqual([]);
    expect(suggestionNeedle(parseSearch('Ana Ruiz, umbrella, ', people))).toBe('umbrella');
    expect(suggestionNeedle(parseSearch('Ana Ruiz, ', people))).toBe('');
    expect(personMatchesNeedle(cora, '')).toBe(false);
    expect(personMatchesNeedle(cora, 'lin')).toBe(true);
  });
});
