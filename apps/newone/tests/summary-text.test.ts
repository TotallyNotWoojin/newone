import { describe, expect, test } from '@jest/globals';

import {
  coveringSummary,
  formatSummaryScope,
  latestSummary,
  newSummarySourceIds,
  relativeTimeLabel,
  stripSummarySourceTokens,
  summaryExportText,
  summaryFileName,
  summaryIsReady,
  summaryScope,
} from '@/data/summary-text';
import type { ConversationSummary, Message } from '@/domain/types';

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'summary-a',
    conversationId: 'conversation-a',
    versionNumber: 1,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Weekend plans',
    summary: 'You asked about Saturday. They said yes.',
    keyTopics: [],
    decisions: [],
    actionItems: [],
    ambiguities: [],
    sourceMessageIds: ['101', '102', '103'],
    sourceFirstMessageId: '101',
    sourceLastMessageId: '103',
    sourceFingerprint: 'a'.repeat(64),
    outputFingerprint: 'b'.repeat(64),
    sourceState: 'current',
    policyState: 'current',
    requestMode: 'manual',
    requestedByUserId: 'user-self',
    correctionOfSummaryId: null,
    provenance: {
      processorType: 'ai', provider: 'openrouter', model: 'model',
      organizationAiPolicyVersion: 1, routePolicyVersion: 'r1', providerRoute: 'route',
    },
    failureCode: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-09-04T10:00:00.000Z',
    generatedAt: '2026-09-04T10:00:05.000Z',
    ...overrides,
  };
}

function message(serverId: string, createdAt?: string): Message {
  return {
    id: `local-${serverId}`,
    serverId,
    conversationId: 'conversation-a',
    senderId: 'user-other',
    senderName: 'Ana',
    senderInitials: 'A',
    senderColor: '#000',
    originalText: `Message ${serverId}`,
    sourceLanguage: 'en',
    translationState: 'not_requested',
    createdAt,
    sentAt: '10:00',
    isOwn: false,
    deliveryState: 'delivered',
    priority: 'normal',
  } as Message;
}

describe('summary text never shows machinery', () => {
  test('strips legacy source-reference suffixes, groups, and bare codes while keeping content', () => {
    expect(stripSummarySourceTokens('North gate [sources:s0002,s0004]')).toBe('North gate');
    expect(stripSummarySourceTokens('Lock at six (s0003) , then leave.')).toBe('Lock at six, then leave.');
    expect(stripSummarySourceTokens('출처 【s0001】 확인 , , 끝.')).toBe('출처 확인, 끝.');
    expect(stripSummarySourceTokens('Model s2024 ships in [Q3].')).toBe('Model s2024 ships in [Q3].');
    expect(stripSummarySourceTokens('s0001')).toBe('');
    expect(stripSummarySourceTokens('First line s0001.\n\n\n\nSecond [sources: s0002] line.')).toBe('First line.\n\nSecond line.');
  });

  test('export text carries the title, one metadata line, and clean prose', () => {
    const text = summaryExportText({
      title: 'Weekend plans (s0001)',
      body: 'You asked about Saturday [sources:s0001]. They said yes.',
      conversationTitle: 'Ana Torres',
      scope: 'Since yesterday 14:03 · 3 messages',
    });
    expect(text).toBe('Weekend plans\nAna Torres · Since yesterday 14:03 · 3 messages\n\nYou asked about Saturday. They said yes.\n');
    expect(summaryExportText({ title: 'T', body: 'B', conversationTitle: 'C', scope: null })).toBe('T\nC\n\nB\n');
    expect(text).not.toMatch(/\bs0\d{3}\b/);
  });

  test('file names are safe and dated', () => {
    const date = new Date(2026, 8, 5, 9, 30);
    expect(summaryFileName('Family: trip/plans?', date)).toBe('Newone summary – Family trip plans – 2026-09-05.txt');
    expect(summaryFileName('   ', date)).toBe('Newone summary – Conversation – 2026-09-05.txt');
    expect(summaryFileName('x'.repeat(80), date)).toBe(`Newone summary – ${'x'.repeat(60)} – 2026-09-05.txt`);
  });
});

describe('summary scope and "since last time"', () => {
  test('picks the newest version and only counts readable ones as ready', () => {
    const summaries = [
      summary({ id: 'v1', versionNumber: 1 }),
      summary({ id: 'v3', versionNumber: 3, status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode: 'x' }),
      summary({ id: 'v2', versionNumber: 2 }),
      summary({ id: 'other', conversationId: 'conversation-b', versionNumber: 9 }),
    ];
    expect(latestSummary(summaries, 'conversation-a')?.id).toBe('v3');
    expect(summaryIsReady(latestSummary(summaries, 'conversation-a'))).toBe(false);
    expect(summaryIsReady(summaries[0])).toBe(true);
    expect(summaryIsReady(undefined)).toBe(false);
  });

  test('the boundary is the requester\'s newest covering summary; failed and superseded versions do not count', () => {
    const summaries = [
      summary({ id: 'mine-1', versionNumber: 1, sourceLastMessageId: '103' }),
      summary({ id: 'theirs', versionNumber: 2, requestedByUserId: 'user-other', sourceLastMessageId: '110' }),
      summary({ id: 'mine-failed', versionNumber: 3, status: 'failed', sourceLastMessageId: '111' }),
      summary({ id: 'mine-superseded', versionNumber: 4, status: 'superseded', sourceLastMessageId: '112' }),
      summary({ id: 'mine-generating', versionNumber: 5, status: 'generating', sourceLastMessageId: '105' }),
    ];
    expect(coveringSummary(summaries, 'conversation-a', 'user-self')?.id).toBe('mine-generating');
    expect(coveringSummary(summaries.slice(0, 4), 'conversation-a', 'user-self')?.id).toBe('mine-1');
    expect(coveringSummary(summaries, 'conversation-a', null)).toBeUndefined();
    expect(coveringSummary(summaries, 'conversation-b', 'user-self')).toBeUndefined();
  });

  test('new source ids start after the boundary, by position or by id, and cap at the request limit', () => {
    const messages = [message('101'), { ...message('x'), serverId: undefined } as Message, message('102'), message('103'), message('104'), message('105')];
    expect(newSummarySourceIds(messages, undefined)).toEqual(['101', '102', '103', '104', '105']);
    expect(newSummarySourceIds(messages, summary({ sourceLastMessageId: '103' }))).toEqual(['104', '105']);
    expect(newSummarySourceIds(messages, summary({ sourceLastMessageId: '105' }))).toEqual([]);
    // The boundary message is no longer loaded: numeric ids still order the scope.
    expect(newSummarySourceIds(messages, summary({ sourceLastMessageId: '102' }).sourceLastMessageId === '102'
      ? summary({ sourceLastMessageId: '1025' }) : undefined)).toEqual([]);
    expect(newSummarySourceIds(messages, summary({ sourceLastMessageId: '100' }))).toEqual(['101', '102', '103', '104', '105']);
    // Non-numeric ids that are not loaded fall back to the whole loaded history.
    expect(newSummarySourceIds(messages, summary({ sourceLastMessageId: 'message-old' }))).toEqual(['101', '102', '103', '104', '105']);
    expect(newSummarySourceIds(messages, undefined, 2)).toEqual(['104', '105']);
  });

  test('scope uses the first covered message time when loaded and formats one metadata line', () => {
    const now = new Date(2026, 8, 5, 12, 0);
    const yesterday = new Date(2026, 8, 4, 14, 3).toISOString();
    const messages = [message('101', yesterday), message('102'), message('103')];
    const copy = {
      locale: 'en',
      sinceTemplate: 'Since {time} · {count} messages',
      countTemplate: '{count} messages',
      today: 'today',
      yesterday: 'yesterday',
    };
    expect(summaryScope(summary(), messages)).toEqual({ since: yesterday, count: 3 });
    expect(formatSummaryScope(summaryScope(summary(), messages), copy, now)).toBe('Since yesterday 2:03 PM · 3 messages');
    expect(formatSummaryScope(summaryScope(summary(), []), copy, now)).toBe('3 messages');
    expect(summaryScope(summary(), [message('101', 'not a date')]).since).toBeNull();
    expect(relativeTimeLabel(new Date(2026, 8, 5, 9, 12).toISOString(), copy, now)).toBe('today 9:12 AM');
    expect(relativeTimeLabel(new Date(2026, 8, 1, 9, 12).toISOString(), copy, now)).toBe('Sep 1, 9:12 AM');
    expect(relativeTimeLabel(new Date(2026, 8, 4, 14, 3).toISOString(), { ...copy, locale: 'ko', yesterday: '어제' }, now)).toBe('어제 오후 2:03');
  });
});
