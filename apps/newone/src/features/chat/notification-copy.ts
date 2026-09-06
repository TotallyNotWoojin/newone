import type { AppLocale } from '@/i18n/catalog';

const copy = {
  en: {
    title: 'Conversation notifications',
    description: 'Choose what notifies you.',
    all: 'All activity',
    mentions: 'Mentions only',
    none: 'Muted until changed',
    temporary: 'Mute temporarily',
    oneHour: '1 hour',
    eightHours: '8 hours',
    oneWeek: '1 week',
    unmute: 'Remove timed mute',
    mutedUntil: 'Timed mute ends',
  },
  ko: {
    title: '대화 알림',
    description: '어떤 활동을 알림으로 받을지 선택하세요.',
    all: '모든 활동',
    mentions: '멘션만',
    none: '변경할 때까지 음소거',
    temporary: '일시적으로 음소거',
    oneHour: '1시간',
    eightHours: '8시간',
    oneWeek: '1주',
    unmute: '시간 제한 음소거 해제',
    mutedUntil: '음소거 종료',
  },
  es: {
    title: 'Notificaciones de la conversación',
    description: 'Elige qué te notifica.',
    all: 'Toda la actividad',
    mentions: 'Solo menciones',
    none: 'Silenciada hasta cambiarla',
    temporary: 'Silenciar temporalmente',
    oneHour: '1 hora',
    eightHours: '8 horas',
    oneWeek: '1 semana',
    unmute: 'Quitar silencio temporal',
    mutedUntil: 'El silencio termina',
  },
} as const;

export function notificationCopy(locale: AppLocale) {
  return copy[locale];
}
