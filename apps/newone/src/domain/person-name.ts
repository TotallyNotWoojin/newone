/**
 * What a person is called on this phone. A nickname is private to the person
 * who set it, so it wins wherever a name is drawn — the chat header, the Chats
 * row, a contact card, a group's member list. Until v3.4 it was stored, made
 * searchable, and then shown nowhere at all.
 */
export function personDisplayName(
  person: { displayName: string; contactAlias?: string | null } | null | undefined,
  fallback = '',
): string {
  if (!person) return fallback;
  return person.contactAlias?.trim() || person.displayName || fallback;
}
