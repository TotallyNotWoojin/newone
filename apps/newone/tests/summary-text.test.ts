import { describe, expect, test } from '@jest/globals';

import {
  SUMMARY_SCOPE_KINDS,
  latestSummary,
  stripSummarySourceTokens,
  summaryCoverageDates,
  summaryCoversLabel,
  summaryExportText,
  summaryFileName,
  summaryIsReady,
  summaryScopeLine,
  summaryTodoText,
} from '@/data/summary-text';
import type { ConversationSummary } from '@/domain/types';

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'summary-a',
    conversationId: 'conversation-a',
    versionNumber: 1,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Weekend plans',
    summary: 'You asked about Saturday. Ana said yes.',
    keyTopics: [],
    decisions: [],
    actionItems: [],
    ambiguities: [],
    sourceMessageIds: ['101', '102', '103'],
    sourceFirstMessageId: '101',
    sourceLastMessageId: '103',
    sourceFingerprint: 'a'.repeat(64),
    outputFingerprint: 'b'.repeat(64),
    scopeKind: 'last_7_days',
    scopeSubject: 'the trip',
    sourceMessageCount: 143,
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

const copy = {
  ranges: {
    unread: 'Unread', today: 'Today', yesterday: 'Yesterday', last_7_days: 'Last 7 days', last_30_days: 'Last 30 days', last_90_days: 'Last 3 months', everything: 'Everything',
  },
  lineTemplate: '{range} · {count} messages',
  lineOneTemplate: '{range} · 1 message',
  aboutTemplate: 'about {subject}',
};

describe('summary text never shows machinery', () => {
  test('strips legacy source-reference suffixes, groups, and bare codes while keeping content', () => {
    expect(stripSummarySourceTokens('North gate [sources:s0002,s0004]')).toBe('North gate');
    expect(stripSummarySourceTokens('Lock at six (s0003) , then leave.')).toBe('Lock at six, then leave.');
    expect(stripSummarySourceTokens('출처 【s0001】 확인 , , 끝.')).toBe('출처 확인, 끝.');
    expect(stripSummarySourceTokens('Model s2024 ships in [Q3].')).toBe('Model s2024 ships in [Q3].');
    expect(stripSummarySourceTokens('s0001')).toBe('');
    expect(stripSummarySourceTokens('First line s0001.\n\n\n\nSecond [sources: s0002] line.')).toBe('First line.\n\nSecond line.');
  });

  test('export text carries the title, one metadata line, and clean lines; nothing else', () => {
    const text = summaryExportText({
      title: 'Weekend plans (s0001)',
      body: '1. Ana: Saturday plans asked [sources:s0001]\n2. Kyle: yes to Saturday',
      conversationTitle: 'Ana Torres',
      scope: 'Last 7 days · 143 messages · about the trip',
    });
    expect(text).toBe(
      'Weekend plans\nAna Torres · Last 7 days · 143 messages · about the trip\n\n1. Ana: Saturday plans asked\n2. Kyle: yes to Saturday\n',
    );
    expect(summaryExportText({ title: 'T', body: 'B', conversationTitle: 'C', scope: null })).toBe('T\nC\n\nB\n');
    expect(text).not.toMatch(/\bs0\d{3}\b/);
  });

  test('to-do lines put the person first, then the task, then the date, and drop empty parts', () => {
    expect(summaryTodoText({ title: 'Book the cabin', owner: 'Ana', dueAt: 'Friday', sourceMessageIds: [] })).toBe('Ana: Book the cabin · Friday');
    expect(summaryTodoText({ title: ' Book (s0001) ', owner: null, dueAt: '  ', sourceMessageIds: [] })).toBe('Book');
    expect(summaryTodoText({ title: '', owner: 'Ana', sourceMessageIds: [] })).toBe('Ana');
    expect(summaryTodoText({ title: '', sourceMessageIds: [] })).toBe('');
  });

  test('the header carries the date and hours covered and the participants', () => {
    expect(summaryExportText({
      title: 'Weekend plans', body: '1. Ana: Saturday plans asked\n2. Kyle: yes to Saturday', conversationTitle: 'Ana Torres',
      scope: 'Last 7 days · 2 messages', covers: 'Sep 14, 2026 · 2:49 PM – 3:44 PM', participants: 'Participants: Kyle, Ana',
    })).toBe(
      'Weekend plans\nAna Torres · Last 7 days · 2 messages\nSep 14, 2026 · 2:49 PM – 3:44 PM\nParticipants: Kyle, Ana\n\n1. Ana: Saturday plans asked\n2. Kyle: yes to Saturday\n',
    );
  });

  test('the covered span shows one date with both hours, or two dated ends across days, and nothing without both ends', () => {
    const from = new Date(2026, 8, 14, 14, 49);
    const until = new Date(2026, 8, 14, 15, 44);
    expect(summaryCoversLabel(from, until, 'en-US')).toBe('Sep 14, 2026 · 2:49 PM – 3:44 PM');
    expect(summaryCoversLabel(new Date(2026, 8, 10, 9, 5), until, 'en-US')).toBe('Sep 10, 2026 9:05 AM – Sep 14, 2026 3:44 PM');
    expect(summaryCoversLabel(null, until, 'en-US')).toBeNull();
    expect(summaryCoversLabel(from, new Date('nonsense'), 'en-US')).toBeNull();
  });

  test('a range reaches back from the day it was asked for; everything has no dates', () => {
    const asked = '2026-09-14T20:00:00.000Z';
    expect(summaryCoverageDates('today', asked)?.from.toISOString()).toBe(asked);
    expect(summaryCoverageDates('yesterday', asked)?.until.getDate()).toBe(new Date(asked).getDate() - 1);
    const span = (kind: 'last_7_days' | 'last_30_days' | 'last_90_days') => {
      const dates = summaryCoverageDates(kind, asked)!;
      return Math.round((dates.until.getTime() - dates.from.getTime()) / 86_400_000);
    };
    expect(span('last_7_days')).toBe(6);
    expect(span('last_30_days')).toBe(29);
    expect(span('last_90_days')).toBe(89);
    expect(summaryCoverageDates('everything', asked)).toBeNull();
    expect(summaryCoverageDates(null, asked)).toBeNull();
    expect(summaryCoverageDates('today', 'not a date')).toBeNull();
  });

  test('file names are safe and dated', () => {
    const date = new Date(2026, 8, 5, 9, 30);
    expect(summaryFileName('Family: trip/plans?', date)).toBe('Gist summary – Family trip plans – 2026-09-05.txt');
    expect(summaryFileName('   ', date)).toBe('Gist summary – Conversation – 2026-09-05.txt');
    expect(summaryFileName('x'.repeat(80), date)).toBe(`Gist summary – ${'x'.repeat(60)} – 2026-09-05.txt`);
  });
});

describe('summary versions and the reader-defined scope', () => {
  test('picks the newest version, the reader\'s own when they have one, and only counts readable ones as ready', () => {
    const summaries = [
      summary({ id: 'v1', versionNumber: 1 }),
      summary({ id: 'v3', versionNumber: 3, status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode: 'x' }),
      summary({ id: 'v2', versionNumber: 2 }),
      summary({ id: 'theirs', versionNumber: 4, requestedByUserId: 'user-other' }),
      summary({ id: 'other', conversationId: 'conversation-b', versionNumber: 9 }),
    ];
    expect(latestSummary(summaries, 'conversation-a')?.id).toBe('theirs');
    expect(latestSummary(summaries, 'conversation-a', 'user-self')?.id).toBe('v3');
    // Another member's request is theirs alone (owner, Sep 14 2026).
    expect(latestSummary(summaries, 'conversation-a', 'user-nobody')).toBeUndefined();
    expect(latestSummary(summaries, 'conversation-c', 'user-self')).toBeUndefined();
    expect(summaryIsReady(latestSummary(summaries, 'conversation-a', 'user-self'))).toBe(false);
    expect(summaryIsReady(summaries[0])).toBe(true);
    expect(summaryIsReady(undefined)).toBe(false);
  });

  test('the scope line names the range, the count, and the subject; older versions carry only the count', () => {
    expect(summaryScopeLine(summary(), copy)).toBe('Last 7 days · 143 messages · about the trip');
    expect(summaryScopeLine(summary({ scopeKind: 'unread', scopeSubject: null, sourceMessageCount: 1 }), copy)).toBe('Unread · 1 message');
    expect(summaryScopeLine(summary({ scopeKind: 'today', scopeSubject: '  ', sourceMessageCount: 12 }), copy)).toBe('Today · 12 messages');
    expect(summaryScopeLine(summary({ scopeKind: null, scopeSubject: null, sourceMessageCount: 3 }), copy)).toBe('3 messages');
    expect(summaryScopeLine(summary({ scopeKind: null, scopeSubject: 'lunch', sourceMessageCount: 1 }), copy)).toBe('1 message · about lunch');
    expect(summaryScopeLine(summary({ scopeKind: 'everything', scopeSubject: null, sourceMessageCount: 2 }), {
      ...copy, lineTemplate: '{range} · 메시지 {count}개',
    })).toBe('Everything · 메시지 2개');
    // Unread left the chips; the longer spans arrived (owner, Sep 14 2026).
    expect(SUMMARY_SCOPE_KINDS).toEqual(['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything']);
  });
});
