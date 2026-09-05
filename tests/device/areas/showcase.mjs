// SHOWCASE: build realistic content with two accounts and capture App Store /
// Play screenshots on a 6.9-inch simulator (NEWONE_SHOT_DEVICE) that is booted
// here in addition to the pool device (B). A lives on the screenshot device.
import { bootAndInstall } from '../lib/devices.mjs';
export const meta = { id: 'showcase', devices: 1, title: 'SHOWCASE screenshots (A on the shot device, B in the pool)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  const [devB] = ctx.devices;
  const devA = process.env.NEWONE_SHOT_DEVICE;
  if (!devA) { ctx.note({ id: 'showcase-blocked', title: 'NEWONE_SHOT_DEVICE not set', status: 'FAIL' }); return; }
  bootAndInstall(devA, (message) => ctx.log(`[shot device] ${message}`));
  const { server } = ctx;
  const [A, B] = await Promise.all([
    ctx.signup(devA, { label: 'show_a', displayName: 'Maya Chen' }),
    ctx.signup(devB, { label: 'show_b', displayName: 'Diego Ruiz', language: 'es' }),
  ]);
  if (!A.signedIn || !B.signedIn) { ctx.note({ id: 'showcase-blocked', title: 'signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` }); return; }
  await ctx.shot(devA, 'shot-00-chats-empty');
  await ctx.step({ id: 'show-01-search', title: 'A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Send message request' }, expected: 'B card', screen: 'people' });
  await ctx.shot(devA, 'shot-01-people-search');
  const request = await ctx.step({ id: 'show-02-request', title: 'A sends a message request', device: devA, flow: 'people/send-message-request.yaml', env: { TEXT: 'Hi Diego! Are you coming to the design review on Monday?' }, expected: 'conversation', screen: 'people → conversation' });
  if (!request.uiOk) return;
  const convId = (await server.directConversation(A.userId, B.userId)).id;
  const accept = await ctx.step({ id: 'show-03-accept', title: 'B accepts', device: devB, flow: 'chat/accept-in-conversation.yaml', env: { NAME: A.displayName }, expected: 'composer', screen: 'chats → conversation' });
  if (!accept.uiOk) return;
  await ctx.step({ id: 'show-04-b-replies', title: 'B replies in Spanish', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: 'Sí, ahí estaré. Llevo el prototipo impreso y las notas del cliente.' }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'show-05-a-sees', title: 'A sees the reply', device: devA, flow: 'chat/see-text.yaml', env: { TEXT: 'prototipo impreso', TIMEOUT: '45000' }, expected: 'visible', screen: 'conversation' });
  // Automatic translation is on by default once the pair (EN ↔ ES) exists.
  await ctx.step({ id: 'show-07-a-sends', title: 'A sends a second text', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: 'Perfect. Can you also bring the updated pricing sheet?' }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'show-08-b-sends', title: 'B answers in Spanish', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: 'Claro, la actualizo esta noche y te la comparto aquí.' }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'show-09-a-sees-translation', title: 'A sees the translation card', device: devA, flow: 'translation/see-translation.yaml', env: { TEXT: 'esta noche', LANG: 'EN', TIMEOUT: '90000' }, expected: 'TRANSLATION · EN card', screen: 'conversation', optional: true });
  await sleep(2000);
  await ctx.shot(devA, 'shot-02-conversation-translation');
  await ctx.step({ id: 'show-10-actions', title: 'A opens message actions', device: devA, flow: 'chat/open-actions.yaml', env: { TARGET: 'esta noche' }, expected: 'Message actions', screen: 'conversation', optional: true });
  await ctx.shot(devA, 'shot-03-message-actions');
  await ctx.step({ id: 'show-11-close-actions', title: 'A closes the sheet', device: devA, flow: 'common/recover.yaml', expected: 'conversation', screen: 'conversation', optional: true });
  await ctx.step({ id: 'show-12-back', title: 'A returns to Chats', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
  await ctx.step({ id: 'show-13-b-sends-unread', title: 'B sends while A is on the list', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: '¿Nos vemos a las 10 en la sala grande?' }, expected: 'bubble', screen: 'conversation' });
  await sleep(6000);
  await ctx.shot(devA, 'shot-04-chats-unread');
  await ctx.step({ id: 'show-14-group', title: 'A creates a group with B', device: devA, flow: 'groups/create-group.yaml', env: { NAME: 'Launch crew', MEMBER1: B.displayName, HAS_MEMBER2: 'false', MEMBER2: '' }, expected: 'group conversation', screen: 'new group', optional: true });
  await ctx.step({ id: 'show-15-group-text', title: 'A posts in the group', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: 'Welcome to the launch crew! Agenda for Monday is pinned.' }, expected: 'bubble', screen: 'conversation', optional: true });
  await sleep(2000);
  await ctx.shot(devA, 'shot-05-group');
  await ctx.step({ id: 'show-16-settings', title: 'A opens Settings', device: devA, flow: 'showcase/open-settings.yaml', expected: 'Settings', screen: 'settings', optional: true });
  await ctx.shot(devA, 'shot-06-settings');
  ctx.accounts = { A, B };
}
