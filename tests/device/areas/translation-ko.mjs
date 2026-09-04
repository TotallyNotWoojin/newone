// TRANSLATION (A en ↔ C ko): the same journey as the Spanish pair with a
// Korean-speaking account, so Korean is exercised on the phone UI and not only
// by the hosted journey smoke.
import { runPair } from './translation.mjs';

export const meta = { id: 'translation-ko', devices: 2, title: 'TRANSLATION (A en ↔ C ko)' };

export async function run(ctx) {
  return runPair(ctx, {
    language: 'ko', code: 'KO', label: 'trko', peerName: 'Chaeyoung',
    intro: (tag) => `Hello Chaeyoung, nice to meet you ${tag}`,
    en1: (tag) => `The meeting moved to Monday morning, please bring the report ${tag}`, en1Key: 'report',
    reply: (tag) => `네, 월요일에 인쇄한 보고서를 가져가겠습니다 ${tag}`, replyKey: '가져가겠습니다',
    en2: (tag) => `Second English message while translation is off ${tag}`,
  });
}
