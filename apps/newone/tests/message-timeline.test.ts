import { describe, expect, test } from '@jest/globals';

import { mergeTimelineMessages } from '@/data/reconciliation/message-timeline.mjs';

type Row = { id?: string; serverId: string | null; clientMessageId?: string | null; body?: string; createdAt?: string; deliveryState?: string; isOwn?: boolean };
const merge = (existing: Row[], incoming: Row[], options?: { pruneMissingWithinPage?: boolean; now?: number }) =>
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

  test('an acknowledged send keeps the id the list is drawing it under', () => {
    // The list keys rows by id. If the server row brought its own, React would
    // unmount the bubble and mount a new one in the middle of a send, and the
    // timeline would re-measure under the reader - the scroll that goes
    // somewhere else and comes back.
    const optimistic = row(null, {
      clientMessageId: 'c1', isOwn: true, deliveryState: 'sending',
      createdAt: '2026-09-04T20:00:50.000Z',
    });
    const acknowledged = row('20', {
      clientMessageId: 'c1', isOwn: true, deliveryState: 'sent',
      createdAt: '2026-09-04T20:00:50.000Z',
    });
    const merged = merge([row('10'), optimistic], [acknowledged]);
    expect(merged).toHaveLength(2);
    const settled = merged.at(-1)!;
    expect(settled.id).toBe(optimistic.id);
    expect(settled.serverId).toBe('20');
    expect(settled.deliveryState).toBe('sent');
  });

  test('a received row newer than the tail page that the page omits is dropped', () => {
    // A deleted the newest message (11); the tail page ends at 10.
    const existing = [row('9'), row('10'), row('11', { isOwn: false })];
    const incoming = [row('9'), row('10')];
    const merged = merge(existing, incoming, { pruneMissingWithinPage: true });
    expect(merged.map((message) => message.serverId)).toEqual(['9', '10']);
  });

  test('an own send acknowledged while the page was in flight is kept until it settles', () => {
    const now = Date.parse('2026-09-04T20:00:20.000Z');
    const fresh = row('11', { isOwn: true, createdAt: '2026-09-04T20:00:15.000Z' });
    const old = row('12', { isOwn: true, createdAt: '2026-09-04T19:50:00.000Z' });
    const merged = merge([row('10'), fresh, old], [row('10')], { pruneMissingWithinPage: true, now });
    expect(merged.map((message) => message.serverId)).toEqual(['10', '11']);
  });

  test('an empty page prunes nothing', () => {
    const existing = [row('10'), row('11')];
    expect(merge(existing, [], { pruneMissingWithinPage: true })).toHaveLength(2);
  });
});
