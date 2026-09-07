import { describe, expect, test } from '@jest/globals';

import {
  conversationDepartureCopy,
  conversationDepartureRestrictionCopy,
  conversationDepartureSectionVisible,
} from '@/features/chat/conversation-departure-copy';
import type { Conversation } from '@/domain/types';

const locales = ['en', 'ko', 'es'] as const;

const departure: NonNullable<Conversation['departure']> = {
  eligible: false,
  restriction: 'direct_mandatory',
  requiresOwnershipTransfer: false,
  historyPreserved: true,
  futureAccessRevoked: true,
};

describe('conversation departure copy', () => {
  test.each(locales)('%s: the line every chat can see says nothing about a company', (locale) => {
    const copy = conversationDepartureCopy(locale);
    expect(copy.unavailable).not.toMatch(/company|회사|empresa/i);
    expect(copy.restrictions.direct_mandatory).not.toMatch(/company|회사|empresa/i);
    expect(conversationDepartureRestrictionCopy(locale, null)).toBe(copy.unavailable);
    expect(conversationDepartureRestrictionCopy(locale, 'direct_mandatory'))
      .toBe(copy.restrictions.direct_mandatory);
  });

  test('an unknown locale falls back to English', () => {
    expect(conversationDepartureCopy('fr' as 'en')).toBe(conversationDepartureCopy('en'));
  });
});

describe('departure section visibility', () => {
  test('a one-to-one chat shows no departure section, whatever the service sent', () => {
    expect(conversationDepartureSectionVisible({ kind: 'direct', departure })).toBe(false);
    expect(conversationDepartureSectionVisible({ kind: 'direct' })).toBe(false);
  });

  test('a group shows it only when the service sent departure options', () => {
    expect(conversationDepartureSectionVisible({
      kind: 'group',
      departure: { ...departure, eligible: true, restriction: null },
    })).toBe(true);
    expect(conversationDepartureSectionVisible({ kind: 'group' })).toBe(false);
    expect(conversationDepartureSectionVisible({
      kind: 'group',
      managementOnly: true,
      departure,
    })).toBe(false);
  });
});
