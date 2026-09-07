/**
 * The Chats search field, as logic.
 *
 * One field does the whole job: type a name and the person is suggested, tap
 * the suggestion and the name becomes a chip with the comma already written so
 * the next name can be typed straight away. Two people chipped means "the
 * conversations containing both", which is how a group is found without
 * remembering its name. Anything that is not a person is a loose word, so
 * "Ana, Ben, beach" reads as "conversations with Ana and Ben containing
 * beach".
 *
 * The field's only state is its text; chips are the comma-separated parts that
 * are already finished, and the tail after the last comma is what is being
 * typed. That is why typing "ana, ben," by hand behaves exactly like tapping
 * two suggestions.
 */

export interface SearchPersonRef {
  id: string;
  displayName: string;
  username?: string | null;
}

export interface SearchConversationRef {
  id: string;
  title: string;
  kind?: string;
  subtitle?: string;
  lastMessage?: string;
  memberIds?: string[];
  directParticipantId?: string;
  managementOnly?: boolean;
}

export interface SearchMessageRef {
  id: string;
  conversationId: string;
  title: string;
  snippet?: string;
  occurredAt?: string;
}

export interface SearchChip {
  /** Position in the comma-separated field, so one tap can clear it. */
  index: number;
  label: string;
  /** Set when the chip names somebody; null for a loose word. */
  personId: string | null;
}

export interface ParsedSearch {
  chips: SearchChip[];
  /** Everybody named by a chip; a conversation must contain all of them. */
  personIds: string[];
  /** Loose words: word chips plus whatever is being typed right now. */
  terms: string[];
  /** The unfinished tail after the last comma; what suggestions look at. */
  draft: string;
  empty: boolean;
}

const GROUP_KINDS = new Set(['group', 'team', 'shift', 'incident', 'announcement']);

function fold(value: string) {
  return value.trim().toLocaleLowerCase();
}

/** Names are typed with or without the "@" and in any case. */
function foldName(value: string) {
  return fold(value).replace(/^@+/, '');
}

export function findSearchPerson(
  token: string,
  people: readonly SearchPersonRef[],
): SearchPersonRef | null {
  const wanted = foldName(token);
  if (!wanted) return null;
  return people.find((person) => (
    foldName(person.displayName) === wanted
    || (person.username ? foldName(person.username) === wanted : false)
  )) ?? null;
}

export function parseSearch(
  value: string,
  people: readonly SearchPersonRef[] = [],
): ParsedSearch {
  const parts = value.split(',');
  const chips: SearchChip[] = [];
  let draft = '';
  parts.forEach((raw, index) => {
    const text = raw.trim();
    if (index === parts.length - 1) {
      draft = text;
      return;
    }
    if (!text) return;
    const person = findSearchPerson(text, people);
    chips.push({
      index,
      label: person ? person.displayName : text,
      personId: person?.id ?? null,
    });
  });
  const personIds: string[] = [];
  const terms: string[] = [];
  for (const chip of chips) {
    if (chip.personId) {
      if (!personIds.includes(chip.personId)) personIds.push(chip.personId);
    } else {
      terms.push(chip.label);
    }
  }
  if (draft) terms.push(draft);
  return {
    chips,
    personIds,
    terms,
    draft,
    empty: chips.length === 0 && draft === '',
  };
}

/** Tapping a suggestion finishes the part being typed and writes the comma. */
export function addPersonToSearch(value: string, name: string) {
  const parts = value.split(',');
  parts[parts.length - 1] = name;
  const kept = parts.map((part) => part.trim()).filter(Boolean);
  return kept.length ? `${kept.join(', ')}, ` : '';
}

/** One tap on a chip clears it and leaves the rest of the field alone. */
export function removeChipFromSearch(value: string, index: number) {
  const parts = value.split(',');
  if (index < 0 || index >= parts.length - 1) return value;
  parts.splice(index, 1);
  const draft = (parts.pop() ?? '').trim();
  const kept = parts.map((part) => part.trim()).filter(Boolean);
  if (!kept.length) return draft;
  return `${kept.join(', ')}, ${draft}`;
}

export function conversationParticipantIds(conversation: SearchConversationRef) {
  const ids = new Set(conversation.memberIds ?? []);
  if (conversation.directParticipantId) ids.add(conversation.directParticipantId);
  return ids;
}

export function isGroupConversation(conversation: SearchConversationRef) {
  return conversation.kind ? GROUP_KINDS.has(conversation.kind) : false;
}

export function conversationMatchesSearch(
  conversation: SearchConversationRef,
  parsed: ParsedSearch,
  messageConversationIds?: ReadonlySet<string>,
) {
  if (conversation.managementOnly) return false;
  if (parsed.empty) return true;
  const participants = conversationParticipantIds(conversation);
  if (!parsed.personIds.every((id) => participants.has(id))) return false;
  if (!parsed.terms.length) return true;
  // A word can land on the group's own name, on the preview line, or inside
  // the conversation, which is what the server's message search answers.
  if (messageConversationIds?.has(conversation.id)) return true;
  const haystack = fold([
    conversation.title,
    conversation.subtitle ?? '',
    conversation.lastMessage ?? '',
  ].join('\n'));
  return parsed.terms.every((term) => haystack.includes(fold(term)));
}

/** What the suggestions under the field are looking for right now. */
export function suggestionNeedle(parsed: ParsedSearch) {
  if (parsed.draft) return parsed.draft;
  const words = parsed.chips.filter((chip) => !chip.personId);
  return words.length ? words[words.length - 1]!.label : '';
}

export function personMatchesNeedle(person: SearchPersonRef, needle: string) {
  const wanted = foldName(needle);
  if (!wanted) return false;
  return foldName(person.displayName).includes(wanted)
    || (person.username ? foldName(person.username).includes(wanted) : false);
}

export type SearchSuggestion =
  | {
      kind: 'person';
      key: string;
      personId: string;
      title: string;
      subtitle: string;
      known: boolean;
    }
  | {
      kind: 'conversation';
      key: string;
      conversationId: string;
      title: string;
      subtitle: string;
      group: boolean;
    }
  | {
      kind: 'message';
      key: string;
      conversationId: string;
      messageId: string;
      title: string;
      subtitle: string;
      occurredAt?: string;
    };

export interface SuggestionLimits {
  people?: number;
  conversations?: number;
  messages?: number;
}

const DEFAULT_LIMITS: Required<SuggestionLimits> = {
  people: 4,
  conversations: 6,
  messages: 8,
};

/**
 * People first, then chats and groups, then messages — the order the phone's
 * own search uses, and the order somebody scanning the list expects.
 */
export function buildSearchSuggestions(input: {
  parsed: ParsedSearch;
  people?: readonly SearchPersonRef[];
  strangers?: readonly SearchPersonRef[];
  conversations?: readonly SearchConversationRef[];
  messages?: readonly SearchMessageRef[];
  limits?: SuggestionLimits;
}): SearchSuggestion[] {
  const { parsed } = input;
  if (parsed.empty) return [];
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const needle = suggestionNeedle(parsed);
  const alreadyChipped = new Set(parsed.personIds);
  const messageConversationIds = new Set((input.messages ?? []).map((item) => item.conversationId));

  const people: SearchSuggestion[] = [];
  const seenPeople = new Set<string>(alreadyChipped);
  const pushPerson = (person: SearchPersonRef, known: boolean) => {
    if (people.length >= limits.people) return;
    if (seenPeople.has(person.id)) return;
    if (!personMatchesNeedle(person, needle)) return;
    seenPeople.add(person.id);
    people.push({
      kind: 'person',
      key: `person:${person.id}`,
      personId: person.id,
      title: person.displayName,
      subtitle: person.username ? `@${person.username}` : '',
      known,
    });
  };
  for (const person of input.people ?? []) pushPerson(person, true);
  for (const person of input.strangers ?? []) pushPerson(person, false);

  const conversations: SearchSuggestion[] = [];
  for (const conversation of input.conversations ?? []) {
    if (conversations.length >= limits.conversations) break;
    if (!conversationMatchesSearch(conversation, parsed, messageConversationIds)) continue;
    conversations.push({
      kind: 'conversation',
      key: `conversation:${conversation.id}`,
      conversationId: conversation.id,
      title: conversation.title,
      subtitle: conversation.subtitle ?? '',
      group: isGroupConversation(conversation),
    });
  }

  const visibleConversationIds = new Set(
    (input.conversations ?? [])
      .filter((conversation) => !conversation.managementOnly)
      .map((conversation) => conversation.id),
  );
  const messages: SearchSuggestion[] = [];
  for (const message of input.messages ?? []) {
    if (messages.length >= limits.messages) break;
    if (!visibleConversationIds.has(message.conversationId)) continue;
    messages.push({
      kind: 'message',
      key: `message:${message.id}`,
      conversationId: message.conversationId,
      messageId: message.id,
      title: message.title,
      subtitle: message.snippet ?? '',
      occurredAt: message.occurredAt,
    });
  }

  return [...people, ...conversations, ...messages];
}
