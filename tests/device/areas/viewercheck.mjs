// VIEWER CHECK: on the screenshot device (signed in as the showcase account),
// send a photo from the library and open it in the full-screen viewer.
import { bootAndInstall, launchApp } from '../lib/devices.mjs';
export const meta = { id: 'viewercheck', devices: 1, title: 'Full-screen image viewer (shot device)' };

export async function run(ctx) {
  const dev = process.env.NEWONE_SHOT_DEVICE;
  const peer = process.env.NEWONE_SHOT_PEER ?? 'Diego Ruiz';
  if (!dev) { ctx.note({ id: 'viewer-blocked', title: 'NEWONE_SHOT_DEVICE not set', status: 'FAIL' }); return; }
  bootAndInstall(dev, (message) => ctx.log(`[shot device] ${message}`));
  launchApp(dev);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const open = await ctx.step({ id: 'viewer-01-open', title: 'Open the conversation', device: dev, flow: 'common/open-conversation.yaml', env: { PEER: peer }, expected: 'composer', screen: 'chats' });
  if (!open.uiOk) return;
  const photo = await ctx.step({ id: 'viewer-02-photo', title: 'Send a photo from the library', device: dev, flow: 'showcase/photo-in-conversation.yaml', env: { PEER: peer }, expected: 'photo bubble with preview', screen: 'conversation', timeoutMs: 240_000 });
  if (!photo.uiOk) return;
  await ctx.step({ id: 'viewer-03-open-viewer', title: 'Tap the preview: full-screen viewer opens; close it', device: dev, flow: 'media/open-image-viewer.yaml', expected: '"Close image" visible, then conversation again', screen: 'conversation → viewer' });
  ctx.accounts = {};
}
