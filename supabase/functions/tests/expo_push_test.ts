import { ExpoPushClient, expoPushToken } from '../_shared/expo-push.ts';
import { assertEquals, assertRejects } from './assert.ts';

const token = 'expo-access-token-that-is-long-enough';

Deno.test('Expo token validation rejects raw APNs and FCM token classes', async () => {
  assertEquals(
    expoPushToken('ExponentPushToken[valid_token-123]'),
    'ExponentPushToken[valid_token-123]',
  );
  assertEquals(expoPushToken('ExpoPushToken[valid_token-123]'), 'ExpoPushToken[valid_token-123]');
  for (
    const value of [
      'a'.repeat(64),
      'fcm:raw-provider-token',
      'ExponentPushToken[bad token]',
      'ExpoPushToken[]',
    ]
  ) await assertRejects(() => expoPushToken(value));
});

Deno.test('Expo tickets separate provider acceptance from delivery and classify unregistered devices', async () => {
  const client = new ExpoPushClient(token, async (_input, init) => {
    const submitted = JSON.parse(String(init?.body));
    assertEquals(submitted.length, 2);
    return Response.json({
      data: [{ status: 'ok', id: 'ticket-001' }, {
        status: 'error',
        message: 'not registered',
        details: { error: 'DeviceNotRegistered' },
      }],
    });
  });
  const results = await client.submit([{
    attemptId: '1',
    to: 'ExponentPushToken[first-token]',
    data: { event_type: 'message.changed' },
    priority: 'normal',
    contentAvailable: true,
  }, {
    attemptId: '2',
    to: 'ExponentPushToken[second-token]',
    data: { event_type: 'message.changed' },
    priority: 'normal',
    contentAvailable: true,
  }]);
  assertEquals(results, [{
    attemptId: '1',
    result: 'accepted',
    providerTicketId: 'ticket-001',
    errorCode: null,
  }, {
    attemptId: '2',
    result: 'device_not_registered',
    providerTicketId: null,
    errorCode: 'DeviceNotRegistered',
  }]);
});

Deno.test('Expo receipts distinguish provider handoff, missing receipts, and permanent failures', async () => {
  const client = new ExpoPushClient(token, async () =>
    Response.json({
      data: {
        'ticket-ok': { status: 'ok' },
        'ticket-gone': {
          status: 'error',
          message: 'gone',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    }));
  assertEquals(await client.receipts(['ticket-ok', 'ticket-missing', 'ticket-gone']), [{
    providerTicketId: 'ticket-ok',
    result: 'delivered',
    errorCode: null,
  }, {
    providerTicketId: 'ticket-missing',
    result: 'pending',
    errorCode: null,
  }, {
    providerTicketId: 'ticket-gone',
    result: 'device_not_registered',
    errorCode: 'DeviceNotRegistered',
  }]);
});
