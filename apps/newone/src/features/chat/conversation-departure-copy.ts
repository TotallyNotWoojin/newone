import type { Conversation } from '@/domain/types';

type Locale = 'en' | 'ko' | 'es';
type Restriction = NonNullable<Conversation['departure']>['restriction'];

const COPY = {
  en: {
    title: 'Leave this group',
    disclosure: 'You’ll stop receiving messages from this group. Your earlier messages stay.',
    transfer: 'You’re the last owner. Choose who becomes the new owner.',
    replacement: 'New owner',
    confirmation: 'I understand',
    confirm: 'Leave group',
    unavailable: 'You cannot leave this company-managed audience yourself.',
    noReplacement: 'Add someone else to the group before leaving.',
    restrictions: {
      direct_mandatory: 'You can’t leave a one-to-one chat.',
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
    disclosure: '이 그룹의 메시지를 더 받지 않게 됩니다. 이전에 보낸 메시지는 남습니다.',
    transfer: '마지막 소유자입니다. 새 소유자가 될 사람을 선택하세요.',
    replacement: '새 소유자',
    confirmation: '이해했습니다',
    confirm: '그룹 나가기',
    unavailable: '회사에서 관리하는 이 대상에서는 직접 나갈 수 없습니다.',
    noReplacement: '나가기 전에 다른 사람을 그룹에 추가하세요.',
    restrictions: {
      direct_mandatory: '1:1 채팅에서는 나갈 수 없습니다.',
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
    disclosure: 'Dejarás de recibir mensajes de este grupo. Tus mensajes anteriores se conservan.',
    transfer: 'Eres la última persona propietaria. Elige quién será la nueva.',
    replacement: 'Nuevo propietario',
    confirmation: 'Entendido',
    confirm: 'Salir del grupo',
    unavailable: 'No puedes salir por tu cuenta de esta audiencia administrada por la empresa.',
    noReplacement: 'Añade a alguien más al grupo antes de salir.',
    restrictions: {
      direct_mandatory: 'No puedes salir de un chat individual.',
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
