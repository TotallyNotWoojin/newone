// TRANSLATION (A en ↔ C ko): the same journey as the Spanish pair with a
// Korean-speaking account, so Korean is exercised on the phone UI and not only
// by the hosted journey smoke. The *Hit fields are words the Korean (or, for
// C's messages, English) translation must contain, since the exact machine
// translation is not deterministic and bubbles carry no translation labels.
import { runPair } from './translation.mjs';

export const meta = { id: 'translation-ko', devices: 2, title: 'TRANSLATION (A en ↔ C ko)' };

export async function run(ctx) {
  return runPair(ctx, {
    language: 'ko', code: 'KO', label: 'trko', peerName: 'Chaeyoung',
    intro: (tag) => `Hello Chaeyoung, nice to meet you ${tag}`,
    en1: (tag) => `The meeting moved to Monday morning, please bring the report ${tag}`, en1Key: 'report', en1Hit: '월요일',
    reply: (tag) => `네, 월요일에 인쇄한 보고서를 가져가겠습니다 ${tag}`, replyKey: '가져가겠습니다', replyHit: 'Monday',
    en2: (tag) => `Second English message while translation is off ${tag}`, en2Hit: '(영어|영문)',
    ownHit: '(영어|영문)',
    mixed: (tag) => `회의는 월요일입니다 but bring the printed report please ${tag}`, mixedKey: (tag) => `printed report please ${tag}`, mixedHit: '(보고서|주세요)', mixedHitEn: 'Monday',
  });
}
