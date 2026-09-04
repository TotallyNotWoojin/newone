// TRANSLATION on two devices: A signs up in English, B in Español (server
// language es, UI switched back to English). English text from A must show
// a Spanish translation card on B with the original still present; latency
// is measured on-device and from the database rows.
export const meta = { id: 'translation', devices: 2, title: 'TRANSLATION (A en ↔ B es)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  return runPair(ctx, {
    language: 'es', code: 'ES', label: 'tr', peerName: 'Beatriz',
    intro: (tag) => `Hello Beatriz, nice to meet you ${tag}`,
    en1: (tag) => `The meeting moved to Monday morning, please bring the report ${tag}`, en1Key: 'report',
    reply: (tag) => `Perfecto, llevaré el informe impreso el lunes ${tag}`, replyKey: 'lunes',
    en2: (tag) => `Second English message while translation is off ${tag}`,
    mixed: (tag) => `La reunión es el lunes but bring the printed report please ${tag}`, mixedKey: (tag) => `printed report please ${tag}`,
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
  await ctx.step({ id: 'setup-tr-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Send message request' }, expected: 'card', screen: 'people' });
  const intro = cfg.intro(tag);
  await ctx.step({ id: 'setup-tr-request', title: 'Setup: A sends a message request', device: devA, flow: 'people/send-message-request.yaml', env: { TEXT: intro }, expected: 'pending conversation', screen: 'people' });
  const accept = await ctx.step({ id: 'setup-tr-accept', title: 'Setup: B accepts in the conversation', device: devB, flow: 'chat/accept-in-conversation.yaml', env: { NAME: A.displayName }, expected: 'composer', screen: 'conversation' });
  if (!accept.uiOk) return;
  const conversation = await server.directConversation(A.userId, B.userId);
  const convId = conversation?.id;

  const en1 = cfg.en1(tag);
  const sentAt = Date.now();
  await ctx.step({ id: 'trans-01-a-sends-english', title: 'A sends an English sentence', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: en1 }, expected: 'bubble', screen: 'conversation' });
  const seen = await ctx.step({
    id: 'trans-02-b-sees-spanish', title: `B sees the ${cfg.code} translation card (TRANSLATION · ${cfg.code}) with the original kept`, device: devB, flow: 'translation/see-translation.yaml', env: { TEXT: en1, LANG: cfg.code, TIMEOUT: '90000' },
    expected: `Within 60s: translation card labelled TRANSLATION · ${cfg.code}, ORIGINAL · EN label and the English text still visible`, screen: 'conversation', latencyFrom: sentAt,
    serverTruth: async () => {
      const w = await server.waitFor(() => server.messageByBody(convId, `${cfg.en1Key} ${tag}`), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 });
      const row = w.row;
      let latency = null;
      if (row?.translation_completed_at && row?.created_at) latency = Math.round((new Date(row.translation_completed_at) - new Date(row.created_at)) / 100) / 10;
      return { ok: w.ok, detail: { translations: row?.translations, serverLatencySeconds: latency, detected: row?.detected_language } };
    },
    timeoutMs: 240_000,
  });
  ctx.note({ id: 'trans-02b-latency', title: `Measured translation latency (send tap → ${cfg.code} card visible on B)`, status: seen.uiOk ? 'INFO' : 'FAIL', observed: `${Math.round((seen.entry.latencyMs ?? 0) / 100) / 10}s on device (includes B flow startup); server row: ${JSON.stringify(seen.serverResult?.detail ?? null)}` });
  await ctx.observe(devB, { id: 'trans-02c-spanish-render', title: `Exact ${cfg.code} rendering on B`, screen: 'conversation' });
  await ctx.step({ id: 'trans-03-details', title: 'Translation details (source/target language, fingerprint)', device: devB, flow: 'translation/show-details.yaml', expected: '"Source language · EN · Target language · ES" visible', screen: 'conversation', optional: true });

  const es1 = cfg.reply(tag);
  const sentEs = Date.now();
  await ctx.step({ id: 'trans-04-b-sends-spanish', title: `B replies in ${cfg.code}`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: es1 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-05-a-sees-english', title: 'A sees the English translation card (TRANSLATION · EN)', device: devA, flow: 'translation/see-translation.yaml', env: { TEXT: es1, LANG: 'EN', TIMEOUT: '90000' },
    expected: 'TRANSLATION · EN card on A within 60s', screen: 'conversation', latencyFrom: sentEs,
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, `${cfg.replyKey} ${tag}`), (r) => (r?.translations ?? '').includes('en=completed'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
    timeoutMs: 240_000,
  });
  await ctx.step({ id: 'trans-06-report-translation-error', title: 'Report translation error (AI quality review)', device: devA, flow: 'translation/report-translation-error.yaml', expected: '"Quality report submitted" and the sheet closes', screen: 'conversation → AI quality review', optional: true });

  await ctx.step({
    id: 'trans-07-translation-off', title: 'B turns translation Off for this conversation', device: devB, flow: 'translation/translation-set.yaml', env: { MODE: 'Off' },
    expected: 'Off chip selected; server translation_mode off', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, B.userId), (r) => r?.translation_mode === 'off', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  const en2 = cfg.en2(tag);
  await ctx.step({ id: 'trans-08-a-sends-2', title: 'A sends another English message', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: en2 }, expected: 'bubble', screen: 'conversation' });
  await sleep(20_000);
  await ctx.step({ id: 'trans-09-b-no-translation', title: 'With translation Off, B sees the original only (no TRANSLATION card)', device: devB, flow: 'translation/expect-no-translation.yaml', env: { TEXT: en2 }, expected: 'No TRANSLATION card rendered while Off', screen: 'conversation' });
  await ctx.step({
    id: 'trans-10-translation-on', title: 'B turns translation back to Automatic', device: devB, flow: 'translation/translation-set.yaml', env: { MODE: 'Automatic' },
    expected: 'server translation_mode automatic', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, B.userId), (r) => r?.translation_mode === 'automatic', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({ id: 'trans-11-translations-return', title: 'Translation cards return after switching back on', device: devB, flow: 'translation/see-translation.yaml', env: { TEXT: en2, LANG: cfg.code, TIMEOUT: '90000' }, expected: `TRANSLATION · ${cfg.code} card visible again`, screen: 'conversation', timeoutMs: 240_000 });

  // Owner backlog (Sep 4 2026): a sender can translate their own message from
  // the actions sheet. B (display language cfg.code) writes English, then
  // asks for it in their own language.
  const own = `Own English note for me ${tag}`;
  await ctx.step({ id: 'trans-12-b-sends-english', title: `B (${cfg.code} display) sends an English message`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: own }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-13-b-translates-own', title: `B long-presses the own message → "Translate for me" → TRANSLATION · ${cfg.code} card`, device: devB, flow: 'translation/translate-own.yaml', env: { TARGET: `note for me ${tag}`, LANG: cfg.code, TIMEOUT: '90000' },
    expected: `Own bubble gains a TRANSLATION · ${cfg.code} card; server translation row target ${cfg.language}`, screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, own), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
    timeoutMs: 240_000,
  });

  // Mixed-language message (owner question): B writes in cfg.language and
  // English in one message. A (English) gets it automatically; B can ask for
  // the whole thing in cfg.language from the actions sheet.
  const mixed = `${cfg.mixed(tag)}`;
  const sentMixed = Date.now();
  await ctx.step({ id: 'trans-14-b-sends-mixed', title: `B sends a mixed ${cfg.code}+EN message`, device: devB, flow: 'chat/send-text.yaml', env: { TEXT: mixed }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({
    id: 'trans-15-a-sees-mixed-english', title: 'A sees the English translation of the mixed message', device: devA, flow: 'translation/see-translation.yaml', env: { TEXT: cfg.mixedKey(tag), LANG: 'EN', TIMEOUT: '90000' },
    expected: 'TRANSLATION · EN card on A', screen: 'conversation', latencyFrom: sentMixed,
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, mixed), (r) => (r?.translations ?? '').includes('en=completed'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: `${w.row?.translations} detection=${w.row?.language_detection_method ?? ''}` }; },
    timeoutMs: 240_000,
  });
  await ctx.step({
    id: 'trans-16-b-translates-mixed', title: `B asks for the mixed message in ${cfg.code} (Translate for me)`, device: devB, flow: 'translation/translate-own.yaml', env: { TARGET: cfg.mixedKey(tag), LANG: cfg.code, TIMEOUT: '90000' },
    expected: `TRANSLATION · ${cfg.code} card on the mixed bubble; server row target ${cfg.language} (source und or en)`, screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, mixed), (r) => (r?.translations ?? '').includes(`${cfg.language}=completed`), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.translations }; },
    timeoutMs: 240_000,
  });
  ctx.accounts = { A, B };
}
