import type { AppLocale } from '@/i18n/catalog';

const copy = {
  en: {
    title: 'Conversation notifications',
    description: 'Choose which activity can notify this account. Company critical-alert policy is evaluated separately by the server.',
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
    description: '이 계정에 알릴 활동을 선택하세요. 회사의 긴급 알림 정책은 서버에서 별도로 판단됩니다.',
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
    description: 'Elige qué actividad puede avisar a esta cuenta. La política de alertas críticas de la empresa se evalúa por separado en el servidor.',
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
