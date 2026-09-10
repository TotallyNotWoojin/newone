// TRANSLATION on two devices: A signs up in English, B in Español (server
// language es, UI switched back to English). English text from A must show
// its Spanish translation as plain text under the original on B (the Sep 2026
// chat stream removed the TRANSLATION/ORIGINAL labels); latency is measured
// on-device and from the database rows. Because the exact machine translation
// is not deterministic, each check waits for a word the translation must
// contain (the *Hit fields) and proves the language pair through the
// long-press sheet's "Show details".
export const meta = { id: 'translation', devices: 2, title: 'TRANSLATION (A en ↔ B es)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  return runPair(ctx, {
    language: 'es', code: 'ES', label: 'tr', peerName: 'Beatriz',
    intro: (tag) => `Hello Beatriz, nice to meet you ${tag}`,
    en1: (tag) => `The meeting moved to Monday morning, please bring the report ${tag}`, en1Key: 'report', en1Hit: '(lunes|Lunes)',
    reply: (tag) => `Perfecto, llevaré el informe impreso el lunes ${tag}`, replyKey: 'lunes', replyHit: 'Monday',
    en2: (tag) => `Second English message while translation is off ${tag}`, en2Hit: '(segundo|Segundo|inglés)',
    ownHit: '(inglés|Inglés)',
    mixed: (tag) => `La reunión es el lunes but bring the printed report please ${tag}`, mixedKey: (tag) => `printed report please ${tag}`, mixedHit: '(por favor|impreso)', mixedHitEn: 'Monday',
    previewText: (tag) => `Nos vemos el lunes por la mañana ${tag}`, previewKey: (tag) => `mañana ${tag}`, previewHit: '(Monday|monday)',
  });
}

export async function runPair(ctx, cfg) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B] = await Promise.all([
    ctx.signup(devA, { label: `${cfg.label}_a`, displayName: `Sim Avery ${tag}`, language: 'en' }),
    ctx.signup(devB, { label: `${cfg.label}_b`, displayName: `Sim ${cfg.peerName} ${tag}`, language: cfg.language }),
  ]);
  if (!A.signedIn || !B.signedIn) {
    ctx.note({ id: 'translation-blocked', title: 'TRANSLATION blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` });
    return;
  }
  // Consumers message anyone directly: no request to send or accept.
  await ctx.step({ id: 'setup-tr-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' }, expected: 'B row with Message', screen: 'contacts → Add a friend' });
  const intro = cfg.intro(tag);
  await ctx.step({ id: 'setup-tr-request', title: 'Setup: A taps Message and sends the first text (chat opens directly)', device: devA, flow: 'people/message-from-result.yaml', env: { NAME: B.displayName, TEXT: intro }, expected: 'conversation open, first text sent', screen: 'contacts → conversation' });
  const accept = await ctx.step({ id: 'setup-tr-accept', title: 'Setup: B opens the chat from Chats (nothing to accept)', device: devB, flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: intro }, expected: 'composer', screen: 'conversation' });
  if (!accept.uiOk) return;
  const conversation = await server.directConversation(A.userId, B.userId);
  const convId = conversation?.id;

  const en1 = cfg.en1(tag);
  const sentAt = Date.now();
  await ctx.step({ id: 'trans-01-a-sends-english', title: 'A sends an English sentence', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: en1 }, expected: 'bubble', screen: 'conversation' });
  const seen = await ctx.step({
    id: 'trans-02-b-sees-spanish', title: `B sees the ${cfg.code} translation as plain text under the English original`, device: devB, flow: 'translation/see-translation.yaml', env: { TEXT: en1, TRANSLATED: cfg.en1Hit, LANG: cfg.code, TIMEOUT: '90000' },
    expected: `Within 60s: translated text containing ${cfg.en1Hit} under the original; the English text stays visible; no TRANSLATION/ORIGINAL labels`, screen: 'conversation', latencyFrom: sentAt,
    serverTruth: async () => {
      const w = await server.waitFor(() => server.messageByBody(convId, `${cfg.en1Key} ${tag}`), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 });
      const row = w.row;
      let latency = null;
      if (row?.translation_completed_at && row?.created_at) latency = Math.round((new Date(row.translation_completed_at) - new Date(row.created_at)) / 100) / 10;
      return { ok: w.ok, detail: { translations: row?.translations, serverLatencySeconds: latency, detected: row?.detected_language } };
    },
    timeoutMs: 240_000,
  });
  ctx.note({ id: 'trans-02b-latency', title: `Measured translation latency (send tap → ${cfg.code} text visible on B)`, status: seen.uiOk ? 'INFO' : 'FAIL', observed: `${Math.round((seen.entry.latencyMs ?? 0) / 100) / 10}s on device (includes B flow startup); server row: ${JSON.stringify(seen.serverResult?.detail ?? null)}` });
  await ctx.observe(devB, { id: 'trans-02c-spanish-render', title: `Exact ${cfg.code} rendering on B`, screen: 'conversation' });
  // v3.3 (backlog 44): the provenance panel is workplace-only now — the consumer
  // sheet deliberately carries no "Show details", and the suite signs in as a
  // consumer. The panel itself is still covered by the workplace contract tests.
  ctx.note({
    id: 'trans-03-details',
    title: 'Translation details from the long-press sheet',
    status: 'UNREACHABLE',
    expected: 'A "Show details" entry in the message sheet',
    observed: 'Consumers have no provenance panel: conversation-pane.tsx gates it on !personalRealm, so the entry does not exist for this account.',
    screen: 'conversation',
  });

  const es1 = cfg.reply(tag);
  const sentEs = Date.now();
  await ctx.step({ id: 'trans-04-b-sends-spanish', title: `B replies in ${cfg.code}`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: es1 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-05-a-sees-english', title: 'A sees the English translation under B\'s reply', device: devA, flow: 'translation/see-translation.yaml', env: { TEXT: es1, TRANSLATED: cfg.replyHit, LANG: 'EN', TIMEOUT: '90000' },
    expected: `English text containing "${cfg.replyHit}" under the original on A within 60s`, screen: 'conversation', latencyFrom: sentEs,
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, `${cfg.replyKey} ${tag}`), (r) => (r?.translations ?? '').includes('en=completed'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
    timeoutMs: 240_000,
  });
  // trans-06-report-translation-error: removed — "Report translation error"
  // (AI quality review) left the consumer bubble and sheet with the Sep 2026
  // chat stream; the feature is gone by design.

  await ctx.step({
    id: 'trans-07-translation-off', title: 'B turns translation Off for this conversation', device: devB, flow: 'translation/translation-set.yaml', env: { MODE: 'Off' },
    expected: 'Off chip selected; server translation_mode off', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, B.userId), (r) => r?.translation_mode === 'off', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  const en2 = cfg.en2(tag);
  await ctx.step({ id: 'trans-08-a-sends-2', title: 'A sends another English message', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: en2 }, expected: 'bubble', screen: 'conversation' });
  await sleep(20_000);
  await ctx.step({ id: 'trans-09-b-no-translation', title: 'With translation Off, B sees the original only (no translated text)', device: devB, flow: 'translation/expect-no-translation.yaml', env: { TEXT: en2, TRANSLATED: cfg.en2Hit }, expected: `No translated text (${cfg.en2Hit}) and no "Translating…" while Off`, screen: 'conversation' });
  await ctx.step({
    id: 'trans-10-translation-on', title: 'B turns translation back to Automatic', device: devB, flow: 'translation/translation-set.yaml', env: { MODE: 'Automatic' },
    expected: 'server translation_mode automatic', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, B.userId), (r) => r?.translation_mode === 'automatic', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({ id: 'trans-11-translations-return', title: 'Translations return after switching back on', device: devB, flow: 'translation/see-translation.yaml', env: { TEXT: en2, TRANSLATED: cfg.en2Hit, LANG: cfg.code, TIMEOUT: '90000' }, expected: `${cfg.code} text (${cfg.en2Hit}) under the second English message`, screen: 'conversation', timeoutMs: 240_000 });

  // Owner backlog (Sep 4 2026): a sender can translate their own message from
  // the actions sheet. B (display language cfg.code) writes English, then
  // asks for it in their own language.
  const own = `Own English note for me ${tag}`;
  await ctx.step({ id: 'trans-12-b-sends-english', title: `B (${cfg.code} display) sends an English message`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: own }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-13-b-translates-own', title: `B long-presses the own message → "Translate for me" → ${cfg.code} text under it`, device: devB, flow: 'translation/translate-own.yaml', env: { TARGET: `note for me ${tag}`, TRANSLATED: cfg.ownHit, LANG: cfg.code, TIMEOUT: '90000' },
    expected: `Own bubble gains ${cfg.code} text (${cfg.ownHit}); server translation row target ${cfg.language}`, screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, own), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
    timeoutMs: 240_000,
  });

  // The Settings switch that decides whether a sender sees their own message
  // the way the other person reads it. The owner reported this twice - own
  // messages translating with it off, then only one of three chats showing a
  // translation with it on - and nothing on a device covered it until now.
  await ctx.step({
    id: 'trans-13b-own-translations-on', title: 'B turns "Show my translations" on in Settings', device: devB,
    flow: 'translation/own-translations-toggle.yaml', env: { WANT: 'on' },
    expected: 'The switch reads "Show my translations: On" after the tap; Settings closes',
    screen: 'settings',
  });
  await ctx.step({
    id: 'trans-13c-own-shows-translation', title: `B's own message carries its ${cfg.code} line with the setting on`, device: devB,
    flow: 'chat/see-text.yaml', env: { TEXT: cfg.ownHit, TIMEOUT: '30000' },
    expected: `The sender's own bubble shows the ${cfg.code} reading without being long-pressed`,
    screen: 'conversation',
  });
  await ctx.step({
    id: 'trans-13d-own-translations-off', title: 'B turns it off again', device: devB,
    flow: 'translation/own-translations-toggle.yaml', env: { WANT: 'off' },
    expected: 'The switch reads "Show my translations: Off"; the setting is the reader\'s own and nobody else sees a change',
    screen: 'settings',
  });

  // Mixed-language message (owner question): B writes in cfg.language and
  // English in one message. A (English) gets it automatically; B can ask for
  // the whole thing in cfg.language from the actions sheet.
  const mixed = `${cfg.mixed(tag)}`;
  const sentMixed = Date.now();
  await ctx.step({ id: 'trans-14-b-sends-mixed', title: `B sends a mixed ${cfg.code}+EN message`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: mixed }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-15-a-sees-mixed-english', title: 'A sees the English translation of the mixed message', device: devA, flow: 'translation/see-translation.yaml', env: { TEXT: cfg.mixedKey(tag), TRANSLATED: cfg.mixedHitEn, LANG: 'EN', TIMEOUT: '90000' },
    expected: `English text ("${cfg.mixedHitEn}") under the mixed original on A`, screen: 'conversation', latencyFrom: sentMixed,
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, mixed), (r) => (r?.translations ?? '').includes('en=completed'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: `${w.row?.translations} detection=${w.row?.language_detection_method ?? ''}` }; },
    timeoutMs: 240_000,
  });
  // "Translate for me" is offered only when the detected language differs from
  // B's display language (or detection fell back to the sender language). A
  // mixed message that the detector settles on B's own language needs no
  // translation, so the sheet correctly omits the action.
  const mixedRow = await server.messageByBody(convId, mixed);
  const mixedNeedsNoTranslation = mixedRow?.detected_language === cfg.language
    && !(mixedRow?.language_detection_method ?? '').endsWith(':sender-language');
  if (mixedNeedsNoTranslation) {
    ctx.note({ id: 'trans-16-b-translates-mixed', title: `B asks for the mixed message in ${cfg.code} (Translate for me)`, status: 'PASS', expected: 'action offered only when a translation is needed', observed: `detected ${mixedRow.detected_language} (${mixedRow.language_detection_method}) equals B's display language; the sheet omits "Translate for me" by design` });
  } else {
    await ctx.step({
      id: 'trans-16-b-translates-mixed', title: `B asks for the mixed message in ${cfg.code} (Translate for me)`, device: devB, flow: 'translation/translate-own.yaml', env: { TARGET: cfg.mixedKey(tag), TRANSLATED: cfg.mixedHit, LANG: cfg.code, TIMEOUT: '90000' },
      expected: `${cfg.code} text (${cfg.mixedHit}) under the mixed bubble; server row target ${cfg.language} (source und or en)`, screen: 'conversation → Message actions',
      serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, mixed), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
      timeoutMs: 240_000,
    });
  }
  // v3.1 (backlog 12): a message that arrives while the Chats list is open shows
  // its translation in the row preview without leaving the list.
  if (cfg.previewText) {
    await ctx.step({ id: 'trans-17-a-back-to-chats', title: 'A returns to the Chats list', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
    const previewText = cfg.previewText(tag);
    const sentPreview = Date.now();
    await ctx.step({ id: 'trans-18-b-sends-while-a-lists', title: `B sends a ${cfg.code} message while A is on the Chats list`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: previewText }, expected: 'bubble', screen: 'conversation' });
    await ctx.step({
      id: 'trans-19-a-preview-translated', title: 'A\'s Chats row for B shows the English translation while the list stays open', device: devA, flow: 'chat/preview-translated.yaml', env: { PEER: B.displayName, HIT: cfg.previewHit, TIMEOUT: '90000' },
      expected: `Row preview containing "" within 90s; the list stays open (no composer)`, screen: 'chats', latencyFrom: sentPreview,
      serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, cfg.previewKey(tag)), (r) => (r?.translations ?? '').includes('en=completed'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
      timeoutMs: 240_000,
    });
  }
  // v3.1 (backlog 6b): "Translation delayed" replaces "Translating…" once a pending
  // translation outlives its normal window. A provider outage cannot be staged
  // against the live backend without touching it, so the state is proven by Jest.
  ctx.note({ id: 'trans-20-translation-delayed', title: 'Bubble says "Translation delayed" when a translation outlives its normal window', status: 'UNREACHABLE', observed: 'A provider outage cannot be staged against the live backend; covered by Jest (conversation-ui: "Translating…" first, "Translation delayed" after 45 s while still pending, translation still applied when it lands).', expected: 'Quiet "Translation delayed" line after 45 s; the translation still arrives later' });
  ctx.accounts = { A, B };
}
