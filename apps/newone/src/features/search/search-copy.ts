import type { AppLocale } from '@/i18n/catalog';
import type {
  SearchLanguageFilter,
  SearchMessageMatchSource,
  SearchMatchSource,
} from '@/domain/types';

interface SearchCopy {
  filters: string;
  filtersDescription: string;
  conversation: string;
  anyConversation: string;
  language: string;
  anyLanguage: string;
  languageLabels: Record<SearchLanguageFilter, string>;
  matchIn: string;
  anyMessageField: string;
  sourceLabels: Record<SearchMessageMatchSource, string>;
  sender: string;
  anySender: string;
  fromDate: string;
  toDate: string;
  datePlaceholder: string;
  dateHint: string;
  invalidDate: string;
  invalidDateRange: string;
  clearFilters: string;
  resultMatchLabels: Record<SearchMatchSource, string>;
  messageFilterNotice: string;
  openResult: (title: string) => string;
}

const copy: Record<AppLocale, SearchCopy> = {
  en: {
    filters: 'Refine results',
    filtersDescription: 'Filters are applied by the secure service and never expand your access.',
    conversation: 'Conversation',
    anyConversation: 'Any authorized conversation',
    language: 'Matched language',
    anyLanguage: 'Any language',
    languageLabels: {
      ko: 'Korean',
      es: 'Spanish',
      en: 'English',
      mixed: 'Mixed language',
      und: 'Unknown language',
    },
    matchIn: 'Message match',
    anyMessageField: 'Any permitted field',
    sourceLabels: {
      original: 'Original text',
      translation: 'Approved translation',
      sender: 'Sender name',
      attachment_filename: 'Clean file name',
    },
    sender: 'Exact sender',
    anySender: 'Any sender',
    fromDate: 'From date',
    toDate: 'Through date',
    datePlaceholder: 'YYYY-MM-DD',
    dateHint: 'Dates use this device’s local time zone.',
    invalidDate: 'Enter real dates as YYYY-MM-DD.',
    invalidDateRange: 'The end date must follow the start date and span no more than ten years.',
    clearFilters: 'Clear filters',
    resultMatchLabels: {
      profile: 'Matched authorized profile',
      conversation: 'Matched conversation',
      original: 'Matched original text',
      translation: 'Matched approved translation',
      sender: 'Matched sender name',
      attachment_filename: 'Matched clean file name',
      announcement: 'Matched update',
      handoff: 'Matched handoff',
    },
    messageFilterNotice: 'A message field or exact sender filter limits results to Messages.',
    openResult: (title) => `Open ${title}`,
  },
  ko: {
    filters: '결과 상세 필터',
    filtersDescription: '필터는 보안 서비스에서 적용되며 현재 접근 권한을 확대하지 않습니다.',
    conversation: '대화',
    anyConversation: '접근 가능한 모든 대화',
    language: '일치 언어',
    anyLanguage: '모든 언어',
    languageLabels: {
      ko: '한국어',
      es: '스페인어',
      en: '영어',
      mixed: '혼합 언어',
      und: '알 수 없는 언어',
    },
    matchIn: '메시지 일치 항목',
    anyMessageField: '허용된 모든 항목',
    sourceLabels: {
      original: '원문',
      translation: '승인된 번역',
      sender: '보낸 사람 이름',
      attachment_filename: '안전 확인된 파일명',
    },
    sender: '보낸 사람 지정',
    anySender: '모든 보낸 사람',
    fromDate: '시작 날짜',
    toDate: '종료 날짜',
    datePlaceholder: 'YYYY-MM-DD',
    dateHint: '날짜는 이 기기의 현지 시간대를 사용합니다.',
    invalidDate: '실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.',
    invalidDateRange: '종료 날짜는 시작 날짜 이후여야 하며 범위는 10년 이하여야 합니다.',
    clearFilters: '필터 지우기',
    resultMatchLabels: {
      profile: '접근 가능한 프로필에서 일치',
      conversation: '대화에서 일치',
      original: '원문에서 일치',
      translation: '승인된 번역에서 일치',
      sender: '보낸 사람 이름에서 일치',
      attachment_filename: '안전 확인된 파일명에서 일치',
      announcement: '공지에서 일치',
      handoff: '인수인계에서 일치',
    },
    messageFilterNotice: '메시지 항목 또는 보낸 사람 필터를 선택하면 결과 유형이 메시지로 제한됩니다.',
    openResult: (title) => `${title} 열기`,
  },
  es: {
    filters: 'Refinar resultados',
    filtersDescription: 'El servicio seguro aplica los filtros sin ampliar tu acceso actual.',
    conversation: 'Conversación',
    anyConversation: 'Cualquier conversación autorizada',
    language: 'Idioma coincidente',
    anyLanguage: 'Cualquier idioma',
    languageLabels: {
      ko: 'Coreano',
      es: 'Español',
      en: 'Inglés',
      mixed: 'Idioma mixto',
      und: 'Idioma desconocido',
    },
    matchIn: 'Coincidencia del mensaje',
    anyMessageField: 'Cualquier campo permitido',
    sourceLabels: {
      original: 'Texto original',
      translation: 'Traducción aprobada',
      sender: 'Nombre del remitente',
      attachment_filename: 'Nombre de archivo limpio',
    },
    sender: 'Remitente exacto',
    anySender: 'Cualquier remitente',
    fromDate: 'Fecha inicial',
    toDate: 'Fecha final',
    datePlaceholder: 'AAAA-MM-DD',
    dateHint: 'Las fechas usan la zona horaria local de este dispositivo.',
    invalidDate: 'Introduce fechas reales con el formato AAAA-MM-DD.',
    invalidDateRange: 'La fecha final debe seguir a la inicial y abarcar diez años como máximo.',
    clearFilters: 'Borrar filtros',
    resultMatchLabels: {
      profile: 'Coincidencia en perfil autorizado',
      conversation: 'Coincidencia en conversación',
      original: 'Coincidencia en texto original',
      translation: 'Coincidencia en traducción aprobada',
      sender: 'Coincidencia en remitente',
      attachment_filename: 'Coincidencia en nombre de archivo limpio',
      announcement: 'Coincidencia en aviso',
      handoff: 'Coincidencia en entrega',
    },
    messageFilterNotice: 'Un campo de mensaje o remitente exacto limita el tipo de resultado a Mensajes.',
    openResult: (title) => `Abrir ${title}`,
  },
};

export function searchCopy(locale: AppLocale): SearchCopy {
  return copy[locale];
}
