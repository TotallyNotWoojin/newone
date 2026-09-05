import { describe, expect, test } from '@jest/globals';

import { mergeTimelineMessages } from '@/data/reconciliation/message-timeline.mjs';

type Row = { id?: string; serverId: string | null; clientMessageId?: string | null; body?: string; createdAt?: string; deliveryState?: string };
const merge = (existing: Row[], incoming: Row[], options?: { pruneMissingWithinPage?: boolean }) =>
  mergeTimelineMessages(existing, incoming, options) as Row[];

const row = (serverId: string | null, extra: Partial<Row> & Record<string, unknown> = {}): Row => ({
  id: serverId ? `server-${serverId}` : `local-${extra.clientMessageId}`,
  serverId,
  clientMessageId: extra.clientMessageId ?? null,
  createdAt: `2026-09-04T20:00:${String(Number(serverId ?? 99)).padStart(2, '0')}.000Z`,
  body: extra.body ?? `message ${serverId}`,
  ...extra,
});

describe('mergeTimelineMessages', () => {
  test('a plain merge keeps rows the page does not mention', () => {
    const existing = [row('10'), row('11'), row('12')];
    const incoming = [row('10'), row('12', { body: 'edited' })];
    const merged = merge(existing, incoming);
    expect(merged.map((message) => message.serverId)).toEqual(['10', '11', '12']);
    expect(merged[2].body).toBe('edited');
  });

  test('a reconcile page drops server rows missing inside its id range', () => {
    // 11 was deleted for everyone: the server page spans 10..13 without it.
    const existing = [row('9'), row('10'), row('11'), row('12'), row('13')];
    const incoming = [row('10'), row('12'), row('13')];
    const merged = merge(existing, incoming, { pruneMissingWithinPage: true });
    expect(merged.map((message) => message.serverId)).toEqual(['9', '10', '12', '13']);
  });

  test('a reconcile page keeps older history and optimistic rows', () => {
    const optimistic = row(null, { clientMessageId: 'c1', deliveryState: 'sending', createdAt: '2026-09-04T20:00:50.000Z' });
    const existing = [row('5'), row('6'), row('10'), optimistic];
    const incoming = [row('10'), row('14')];
    const merged = merge(existing, incoming, { pruneMissingWithinPage: true });
    expect(merged.map((message) => message.serverId ?? message.clientMessageId)).toEqual(['5', '6', '10', '14', 'c1']);
  });

  test('an empty page prunes nothing', () => {
    const existing = [row('10'), row('11')];
    expect(merge(existing, [], { pruneMissingWithinPage: true })).toHaveLength(2);
  });
});
