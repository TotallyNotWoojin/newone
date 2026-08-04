import type { AppLocale } from '@/i18n/catalog';

const copy = {
  en: {
    title: 'Automatic translation',
    description: 'Controls this account in this conversation. Originals always remain available. Company AI policy is still the higher-level egress gate.',
    automatic: 'Automatic',
    off: 'Off',
    automaticHint: 'Your server-owned message language can contribute a translation target when someone sends a message.',
    offHint: 'You will not request or see derived translations here. A shared translation may still exist when another authorized recipient needs the same language.',
  },
  ko: {
    title: '자동 번역',
    description: '이 대화에서 이 계정에만 적용됩니다. 원문은 항상 사용할 수 있습니다. 회사 AI 정책이 상위 데이터 전송 기준으로 계속 적용됩니다.',
    automatic: '자동',
    off: '끄기',
    automaticHint: '메시지가 전송되면 서버가 관리하는 내 메시지 언어가 번역 대상 언어에 포함될 수 있습니다.',
    offHint: '여기서 파생 번역을 요청하거나 볼 수 없습니다. 다른 권한 있는 수신자가 같은 언어를 필요로 하면 공유 번역 데이터는 존재할 수 있습니다.',
  },
  es: {
    title: 'Traducción automática',
    description: 'Controla esta cuenta en esta conversación. Los originales siempre siguen disponibles. La política de IA de la empresa sigue siendo la puerta superior de salida de datos.',
    automatic: 'Automática',
    off: 'Desactivada',
    automaticHint: 'El idioma de mensajes administrado por el servidor puede aportar un idioma de destino cuando alguien envía un mensaje.',
    offHint: 'No solicitarás ni verás traducciones derivadas aquí. Los datos compartidos pueden existir si otro destinatario autorizado necesita el mismo idioma.',
  },
} as const;

export function translationPreferenceCopy(locale: AppLocale) {
  return copy[locale];
}
