import type { AuditAccessReason } from '@/domain/types';

export interface AuditCopy {
  eyebrow: string;
  title: string;
  description: string;
  privacyNotice: string;
  verificationRequired: string;
  verifyNow: string;
  reasonLabel: string;
  reasonHelp: string;
  reasons: Record<AuditAccessReason, string>;
  rangeLabel: string;
  ranges: Record<'day' | 'week' | 'month', string>;
  eventTypesLabel: string;
  eventTypesPlaceholder: string;
  targetTypeLabel: string;
  targetTypePlaceholder: string;
  targetIdLabel: string;
  targetIdPlaceholder: string;
  viewRecords: string;
  loadMore: string;
  exportJson: string;
  exportCsv: string;
  emptyTitle: string;
  emptyBody: string;
  actorUnknown: string;
  succeeded: string;
  denied: string;
  failed: string;
  snapshot: string;
  filterReceipt: string;
  exportReady: string;
  exportReceipt: string;
  rows: string;
  digest: string;
  saveExport: string;
  saveFailed: string;
  integrityFailed: string;
  invalidEventTypes: string;
  chooseReason: string;
  actionFailed: string;
}

const copies: Record<'en' | 'ko' | 'es', AuditCopy> = {
  en: {
    eyebrow: 'SECURITY AND COMPLIANCE',
    title: 'Audit access',
    description: 'Purpose-bound access to security events, administrative changes, and system outcomes.',
    privacyNotice: 'Every view and export is recorded. Results contain identifiers and outcomes only, never message text, attachment names, metadata, IP hashes, or user-agent fingerprints.',
    verificationRequired: 'Recent two-step verification is required. Verify again if your secure session is more than 15 minutes old.',
    verifyNow: 'Verify now',
    reasonLabel: 'Access purpose',
    reasonHelp: 'Choose the approved purpose that best describes this review.',
    reasons: {
      security_review: 'Security review',
      compliance_review: 'Compliance review',
      incident_investigation: 'Incident investigation',
      access_review: 'Access review',
    },
    rangeLabel: 'Time range',
    ranges: { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days' },
    eventTypesLabel: 'Event types (optional)',
    eventTypesPlaceholder: 'member.suspended, role.assignment.granted',
    targetTypeLabel: 'Target type (optional)',
    targetTypePlaceholder: 'membership',
    targetIdLabel: 'Target identifier (optional)',
    targetIdPlaceholder: 'UUID or bounded system identifier',
    viewRecords: 'View audit records',
    loadMore: 'Load more',
    exportJson: 'Export JSON',
    exportCsv: 'Export CSV',
    emptyTitle: 'No matching records',
    emptyBody: 'Adjust the time range or filters, then run an intentional audited view.',
    actorUnknown: 'System actor',
    succeeded: 'Succeeded',
    denied: 'Denied',
    failed: 'Failed',
    snapshot: 'Snapshot',
    filterReceipt: 'Filter receipt',
    exportReady: 'Content-free export ready',
    exportReceipt: 'Receipt',
    rows: 'rows',
    digest: 'SHA-256',
    saveExport: 'Save or share export',
    saveFailed: 'The secure save or share action failed. The export was not copied to the clipboard.',
    integrityFailed: 'The export changed after verification and was blocked. Generate a new export.',
    invalidEventTypes: 'Use at most 10 unique event types separated by commas.',
    chooseReason: 'Choose an access purpose before continuing.',
    actionFailed: 'The audit request could not be completed. Check verification and try again.',
  },
  ko: {
    eyebrow: '보안 및 규정 준수',
    title: '감사 로그 접근',
    description: '보안 이벤트, 관리자 변경 사항 및 시스템 처리 결과를 목적에 따라 조회합니다.',
    privacyNotice: '모든 조회와 내보내기는 기록됩니다. 결과에는 식별자와 처리 결과만 포함되며 메시지 본문, 첨부 파일 이름, 메타데이터, IP 해시 또는 사용자 에이전트 지문은 포함되지 않습니다.',
    verificationRequired: '최근 2단계 인증이 필요합니다. 보안 세션이 15분을 초과했다면 다시 인증하세요.',
    verifyNow: '지금 인증',
    reasonLabel: '접근 목적',
    reasonHelp: '이번 검토에 가장 적합한 승인된 목적을 선택하세요.',
    reasons: {
      security_review: '보안 검토',
      compliance_review: '규정 준수 검토',
      incident_investigation: '사고 조사',
      access_review: '접근 권한 검토',
    },
    rangeLabel: '기간',
    ranges: { day: '최근 24시간', week: '최근 7일', month: '최근 30일' },
    eventTypesLabel: '이벤트 유형(선택 사항)',
    eventTypesPlaceholder: 'member.suspended, role.assignment.granted',
    targetTypeLabel: '대상 유형(선택 사항)',
    targetTypePlaceholder: 'membership',
    targetIdLabel: '대상 식별자(선택 사항)',
    targetIdPlaceholder: 'UUID 또는 제한된 시스템 식별자',
    viewRecords: '감사 기록 보기',
    loadMore: '더 불러오기',
    exportJson: 'JSON 내보내기',
    exportCsv: 'CSV 내보내기',
    emptyTitle: '일치하는 기록 없음',
    emptyBody: '기간이나 필터를 조정한 뒤 기록되는 조회를 다시 실행하세요.',
    actorUnknown: '시스템 행위자',
    succeeded: '성공',
    denied: '거부됨',
    failed: '실패',
    snapshot: '스냅샷',
    filterReceipt: '필터 영수증',
    exportReady: '콘텐츠 없는 내보내기 준비 완료',
    exportReceipt: '영수증',
    rows: '개 행',
    digest: 'SHA-256',
    saveExport: '내보내기 저장 또는 공유',
    saveFailed: '안전한 저장 또는 공유 작업에 실패했습니다. 내보내기는 클립보드에 복사되지 않았습니다.',
    integrityFailed: '검증 후 내보내기 내용이 변경되어 차단되었습니다. 새 내보내기를 생성하세요.',
    invalidEventTypes: '쉼표로 구분된 고유 이벤트 유형을 최대 10개까지 입력하세요.',
    chooseReason: '계속하기 전에 접근 목적을 선택하세요.',
    actionFailed: '감사 요청을 완료할 수 없습니다. 인증 상태를 확인하고 다시 시도하세요.',
  },
  es: {
    eyebrow: 'SEGURIDAD Y CUMPLIMIENTO',
    title: 'Acceso de auditoría',
    description: 'Acceso con propósito declarado a eventos de seguridad, cambios administrativos y resultados del sistema.',
    privacyNotice: 'Cada consulta y exportación queda registrada. Los resultados solo contienen identificadores y resultados; nunca texto de mensajes, nombres de archivos adjuntos, metadatos, hashes de IP ni huellas del agente de usuario.',
    verificationRequired: 'Se requiere una verificación reciente en dos pasos. Vuelve a verificarte si tu sesión segura tiene más de 15 minutos.',
    verifyNow: 'Verificar ahora',
    reasonLabel: 'Propósito del acceso',
    reasonHelp: 'Elige el propósito aprobado que mejor describa esta revisión.',
    reasons: {
      security_review: 'Revisión de seguridad',
      compliance_review: 'Revisión de cumplimiento',
      incident_investigation: 'Investigación de incidente',
      access_review: 'Revisión de acceso',
    },
    rangeLabel: 'Intervalo',
    ranges: { day: 'Últimas 24 horas', week: 'Últimos 7 días', month: 'Últimos 30 días' },
    eventTypesLabel: 'Tipos de evento (opcional)',
    eventTypesPlaceholder: 'member.suspended, role.assignment.granted',
    targetTypeLabel: 'Tipo de objetivo (opcional)',
    targetTypePlaceholder: 'membership',
    targetIdLabel: 'Identificador objetivo (opcional)',
    targetIdPlaceholder: 'UUID o identificador acotado del sistema',
    viewRecords: 'Ver registros de auditoría',
    loadMore: 'Cargar más',
    exportJson: 'Exportar JSON',
    exportCsv: 'Exportar CSV',
    emptyTitle: 'No hay registros coincidentes',
    emptyBody: 'Ajusta el intervalo o los filtros y vuelve a ejecutar una consulta auditada intencional.',
    actorUnknown: 'Actor del sistema',
    succeeded: 'Correcto',
    denied: 'Denegado',
    failed: 'Fallido',
    snapshot: 'Instantánea',
    filterReceipt: 'Recibo del filtro',
    exportReady: 'Exportación sin contenido lista',
    exportReceipt: 'Recibo',
    rows: 'filas',
    digest: 'SHA-256',
    saveExport: 'Guardar o compartir',
    saveFailed: 'Falló la acción segura de guardar o compartir. La exportación no se copió al portapapeles.',
    integrityFailed: 'La exportación cambió después de verificarse y fue bloqueada. Genera una nueva exportación.',
    invalidEventTypes: 'Usa un máximo de 10 tipos de evento únicos separados por comas.',
    chooseReason: 'Elige un propósito de acceso antes de continuar.',
    actionFailed: 'No se pudo completar la solicitud de auditoría. Comprueba la verificación e inténtalo de nuevo.',
  },
};

export function auditCopy(locale: string): AuditCopy {
  const language = locale.toLowerCase().split('-')[0];
  return copies[language === 'ko' || language === 'es' ? language : 'en'];
}
