import type { Conversation } from '@/domain/types';

type Locale = 'en' | 'ko' | 'es';
type Restriction = NonNullable<Conversation['departure']>['restriction'];

const COPY = {
  en: {
    title: 'Leave this group',
    disclosure: 'Existing messages and company records stay preserved. You will immediately lose future messages, posting, search, file, notification, and realtime access for this group.',
    transfer: 'You are the last active owner. Choose an active member who will become owner in the same transaction.',
    replacement: 'Replacement owner',
    confirmation: 'I understand that history is preserved and my future access ends.',
    confirm: 'Leave group',
    unavailable: 'You cannot leave this company-managed audience yourself.',
    noReplacement: 'No active replacement is available. Add an active member before leaving.',
    restrictions: {
      direct_mandatory: 'Direct-message membership is fixed.',
      announcement_mandatory: 'Company announcement audiences are managed by administrators.',
      team_mandatory: 'Team membership follows company structure.',
      shift_mandatory: 'Shift membership follows operational assignments.',
      incident_mandatory: 'Incident rooms preserve their required responder audience.',
      policy_managed: 'A dynamic company policy manages this group.',
      audience_mandatory: 'This organization or unit audience is mandatory.',
      mandatory_audience: 'This audience is mandatory.',
    },
  },
  ko: {
    title: '이 그룹 나가기',
    disclosure: '기존 메시지와 회사 기록은 보존됩니다. 이 그룹의 새 메시지, 게시, 검색, 파일, 알림 및 실시간 접근 권한은 즉시 종료됩니다.',
    transfer: '현재 마지막 활성 소유자입니다. 같은 작업에서 소유자가 될 활성 멤버를 선택하세요.',
    replacement: '새 소유자',
    confirmation: '기록은 보존되고 이후 접근 권한이 종료됨을 이해했습니다.',
    confirm: '그룹 나가기',
    unavailable: '회사에서 관리하는 이 대상에서는 직접 나갈 수 없습니다.',
    noReplacement: '선택할 수 있는 활성 멤버가 없습니다. 나가기 전에 활성 멤버를 추가하세요.',
    restrictions: {
      direct_mandatory: '1:1 대화 멤버십은 고정되어 있습니다.',
      announcement_mandatory: '회사 공지 대상은 관리자가 관리합니다.',
      team_mandatory: '팀 멤버십은 회사 조직 구조를 따릅니다.',
      shift_mandatory: '교대조 멤버십은 운영 배정을 따릅니다.',
      incident_mandatory: '사고 대응방은 필수 대응 대상을 유지합니다.',
      policy_managed: '동적 회사 정책이 이 그룹을 관리합니다.',
      audience_mandatory: '이 조직 또는 부서 대상은 필수입니다.',
      mandatory_audience: '이 대상은 필수입니다.',
    },
  },
  es: {
    title: 'Salir de este grupo',
    disclosure: 'Los mensajes y registros existentes de la empresa se conservan. Perderás de inmediato el acceso futuro a mensajes, publicaciones, búsqueda, archivos, notificaciones y tiempo real de este grupo.',
    transfer: 'Eres la última persona propietaria activa. Elige un miembro activo que se convertirá en propietario en la misma transacción.',
    replacement: 'Nuevo propietario',
    confirmation: 'Entiendo que el historial se conserva y que mi acceso futuro termina.',
    confirm: 'Salir del grupo',
    unavailable: 'No puedes salir por tu cuenta de esta audiencia administrada por la empresa.',
    noReplacement: 'No hay un reemplazo activo disponible. Agrega un miembro activo antes de salir.',
    restrictions: {
      direct_mandatory: 'La membresía del mensaje directo es fija.',
      announcement_mandatory: 'Las audiencias de anuncios de la empresa las gestionan administradores.',
      team_mandatory: 'La membresía del equipo sigue la estructura de la empresa.',
      shift_mandatory: 'La membresía del turno sigue las asignaciones operativas.',
      incident_mandatory: 'Las salas de incidentes conservan su audiencia obligatoria.',
      policy_managed: 'Una política dinámica de la empresa gestiona este grupo.',
      audience_mandatory: 'Esta audiencia de organización o unidad es obligatoria.',
      mandatory_audience: 'Esta audiencia es obligatoria.',
    },
  },
} as const;

export function conversationDepartureCopy(locale: Locale) {
  return COPY[locale] ?? COPY.en;
}

export function conversationDepartureRestrictionCopy(locale: Locale, restriction: Restriction) {
  const copy = conversationDepartureCopy(locale);
  return restriction ? copy.restrictions[restriction] : copy.unavailable;
}
