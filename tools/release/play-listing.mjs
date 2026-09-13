// Fill the Play store listing: text, icon, feature graphic and phone
// screenshots. Usage: node tools/release/play-listing.mjs <image-dir>
//
// <image-dir> holds icon-512.png, feature-graphic.png and phone-*.png.
//
// Play's phone screenshots must have their long side no more than twice the
// short side; the iOS captures are 1:2.17 and are rejected as-is, so pad them
// to 9:16 before pointing this at them.
//
// Graphics are uploaded per language rather than relying on fallback, so each
// listing is complete on its own.
import { createSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PKG = 'com.totallynotwoojin.gist';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
// Uploads must go to the www.googleapis.com upload host. Posting them to
// androidpublisher.googleapis.com/upload/... answers 200 with a plausible
// body and stores nothing, so the read-back below is the only thing that
// catches it. Images are read, written and deleted under /listings/; the
// /images/ path 404s.
const UPLOAD = 'https://www.googleapis.com/upload/androidpublisher/v3';

// The web app moved to gist-legal when the Pages repo was renamed; newonechat.com
// never resolved and is not ours.
const WEB = 'https://totallynotwoojin.github.io/gist-legal/app';

const LISTINGS = {
  'en-US': {
    title: 'Gist Chat',
    shortDescription: 'Write in your language. They read it in theirs, original always kept.',
    fullDescription: `Gist is texting for people who don't share a language.

Write in English, Spanish, or Korean. The other person reads it in theirs, with the original kept right above the translation, so nothing gets lost.

WHAT YOU GET
• One-to-one chats and groups with replies, reactions, edits, forwards, and pins
• Photos, videos, voice messages, and files, shown full size
• Translation you can turn on or off per chat, or show only the translation with a tap to see the original
• A short summary of what you missed in a long chat, ready to share
• Notifications that show the message in your language
• Sign in with a password or an emailed code, and use it on your computer in a browser too
• Find people by name or @username, and add anyone to a group

Gist works on your phone and in a desktop browser at ${WEB}.

Translation is automatic and can be wrong. For anything that matters — safety, legal, medical — check with someone who speaks the language before acting on it.`,
  },
  'es-ES': {
    title: 'Gist Chat',
    shortDescription: 'Escribe en tu idioma. La otra persona lo lee en el suyo, con el original.',
    fullDescription: `Gist es mensajería para personas que no hablan el mismo idioma.

Escribe en español, inglés o coreano. La otra persona lo lee en su idioma, con el original siempre encima de la traducción, para que nada se pierda.

QUÉ INCLUYE
• Chats individuales y grupos con respuestas, reacciones, ediciones, reenvíos y mensajes fijados
• Fotos, vídeos, mensajes de voz y archivos, a tamaño completo
• Traducción que puedes activar o desactivar por chat, o ver solo la traducción y tocar para leer el original
• Un resumen breve de lo que te perdiste en una conversación larga, listo para compartir
• Notificaciones que muestran el mensaje en tu idioma
• Inicia sesión con contraseña o con un código por correo, y úsalo también en el navegador de tu ordenador
• Encuentra personas por nombre o @usuario, y añade a cualquiera a un grupo

Gist funciona en el móvil y en el navegador de tu ordenador en ${WEB}.

La traducción es automática y puede equivocarse. Para todo lo importante — seguridad, temas legales o médicos — confírmalo con alguien que hable el idioma antes de actuar.`,
  },
  // Play's Korean locale is ko-KR. "Gist" reads 기스트, which has no final
  // consonant, so the topic particle is 는 and not 은.
  'ko-KR': {
    title: 'Gist Chat',
    shortDescription: '내 언어로 쓰면 상대는 자기 언어로 읽습니다. 원문도 함께 남습니다.',
    fullDescription: `Gist는 서로 다른 언어를 쓰는 사람들을 위한 메신저입니다.

한국어, 영어, 스페인어 중 내 언어로 쓰면 상대는 자기 언어로 읽습니다. 원문은 항상 번역 위에 남아 있어 아무것도 사라지지 않습니다.

주요 기능
• 답장, 반응, 수정, 전달, 고정이 되는 1:1 채팅과 그룹 채팅
• 사진, 동영상, 음성 메시지, 파일을 원본 크기로
• 채팅별로 번역을 켜고 끄거나, 번역만 보고 탭 한 번으로 원문 확인
• 긴 대화에서 놓친 내용을 짧게 요약하고 바로 공유
• 내 언어로 메시지 내용이 표시되는 알림
• 비밀번호 또는 이메일 인증 코드로 로그인, 컴퓨터 브라우저에서도 사용
• 이름이나 @사용자 이름으로 사람을 찾고 누구든 그룹에 추가

Gist는 휴대폰과 데스크톱 브라우저(${WEB})에서 모두 사용할 수 있습니다.

번역은 자동이며 틀릴 수 있습니다. 안전, 법률, 의료처럼 중요한 사안은 해당 언어를 아는 사람에게 확인한 뒤 판단하세요.`,
  },
};

async function token() {
  const key = JSON.parse(readFileSync(`${process.env.HOME}/.config/newone/play-service-account.json`, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await (await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })).json();
  if (!res.access_token) throw new Error(`no Play token: ${JSON.stringify(res).slice(0, 200)}`);
  return res.access_token;
}

export async function publishListing(imageDir, log = console.log) {
  const auth = { Authorization: `Bearer ${await token()}` };
  const json = { ...auth, 'Content-Type': 'application/json' };

  const edit = await (await fetch(`${API}/applications/${PKG}/edits`, { method: 'POST', headers: auth })).json();
  const base = `${API}/applications/${PKG}/edits/${edit.id}`;
  const upBase = `${UPLOAD}/applications/${PKG}/edits/${edit.id}`;

  const shots = readdirSync(imageDir).filter((n) => n.startsWith('phone-') && n.endsWith('.png')).sort();

  for (const [language, listing] of Object.entries(LISTINGS)) {
    const res = await fetch(`${base}/listings/${language}`, {
      method: 'PUT', headers: json, body: JSON.stringify({ language, ...listing }),
    });
    if (!res.ok) throw new Error(`listing ${language}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    log(`  ${language.padEnd(6)} text ok (short ${listing.shortDescription.length}/80, full ${listing.fullDescription.length}/4000)`);

    const put = async (type, file) => {
      // Replace rather than append, so a re-run does not stack duplicates.
      await fetch(`${base}/listings/${language}/${type}`, { method: 'DELETE', headers: auth });
      const r = await fetch(`${upBase}/listings/${language}/${type}?uploadType=media`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: readFileSync(file),
      });
      if (!r.ok) throw new Error(`${type} ${language}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    };

    await put('icon', join(imageDir, 'icon-512.png'));
    await put('featureGraphic', join(imageDir, 'feature-graphic.png'));
    // phoneScreenshots is a collection: delete once, then add each.
    await fetch(`${base}/listings/${language}/phoneScreenshots`, { method: 'DELETE', headers: auth });
    for (const name of shots) {
      const r = await fetch(`${upBase}/listings/${language}/phoneScreenshots?uploadType=media`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' },
        body: readFileSync(join(imageDir, name)),
      });
      if (!r.ok) throw new Error(`screenshot ${name} ${language}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    // Read back inside the same edit: a silent no-op is the failure mode here.
    for (const [type, want] of [['icon', 1], ['featureGraphic', 1], ['phoneScreenshots', shots.length]]) {
      const got = ((await (await fetch(`${base}/listings/${language}/${type}`, { headers: auth })).json()).images ?? []).length;
      if (got !== want) throw new Error(`${language} ${type}: uploaded ${want}, server has ${got}`);
    }
    log(`  ${language.padEnd(6)} icon + feature graphic + ${shots.length} screenshots ok`);
  }

  const commit = await fetch(`${base}:commit`, { method: 'POST', headers: auth });
  if (!commit.ok) throw new Error(`commit: ${commit.status} ${(await commit.text()).slice(0, 300)}`);
  log('listing committed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: play-listing.mjs <image-dir>');
  await publishListing(dir);
}
