import type { AppLocale } from '@/i18n/catalog';

const copy = {
  en: {
    title: 'Automatic translation',
    description: 'Translates messages in this chat for you. Originals always stay.',
    automatic: 'Automatic',
    off: 'Off',
    automaticHint: 'Messages are translated to your language as they arrive.',
    offHint: 'You’ll see messages as they were written.',
  },
  ko: {
    title: '자동 번역',
    description: '이 채팅의 메시지를 내 언어로 번역합니다. 원문은 항상 남습니다.',
    automatic: '자동',
    off: '끄기',
    automaticHint: '메시지가 도착하면 내 언어로 번역됩니다.',
    offHint: '메시지를 원문 그대로 봅니다.',
  },
  es: {
    title: 'Traducción automática',
    description: 'Traduce para ti los mensajes de este chat. Los originales siempre se conservan.',
    automatic: 'Automática',
    off: 'Desactivada',
    automaticHint: 'Los mensajes se traducen a tu idioma al llegar.',
    offHint: 'Verás los mensajes tal como se escribieron.',
  },
} as const;

export function translationPreferenceCopy(locale: AppLocale) {
  return copy[locale];
}
