import type { LanguageCode } from '@/domain/types';

export interface ModerationCopy {
  eyebrow: string;
  title: string;
  description: string;
  privacyBoundary: string;
  aal2Ready: string;
  aal2Required: string;
  verifyNow: string;
  refresh: string;
  refreshing: string;
  loading: string;
  empty: string;
  activeFilter: string;
  openFilter: string;
  closedFilter: string;
  allFilter: string;
  protectedReporter: string;
  scopedEvidence: string;
  noContentList: string;
  target: string;
  targetMessage: string;
  targetGroup: string;
  targetMember: string;
  claim: string;
  assign: string;
  reassign: string;
  review: string;
  viewCase: string;
  resolve: string;
  dismiss: string;
  close: string;
  cancel: string;
  submit: string;
  working: string;
  actionReason: string;
  actionReasonPlaceholder: string;
  investigator: string;
  noEligibleInvestigator: string;
  evidenceReference: string;
  evidenceReferencePlaceholder: string;
  policyCode: string;
  policyCodePlaceholder: string;
  severity: string;
  severityLow: string;
  severityMedium: string;
  severityHigh: string;
  severityCritical: string;
  assignmentTitle: string;
  assignmentDescription: string;
  claimTitle: string;
  claimDescription: string;
  reviewTitle: string;
  reviewDescription: string;
  resolveTitle: string;
  resolveDescription: string;
  dismissTitle: string;
  dismissDescription: string;
  caseReference: string;
  reported: string;
  updated: string;
  assigned: string;
  details: string;
  detailsEmpty: string;
  evidenceTitle: string;
  evidenceDescription: string;
  targetOnlyDescription: string;
  evidenceReported: string;
  evidenceBefore: string;
  evidenceAfter: string;
  attachmentEvidence: string;
  historyTitle: string;
  historyDescription: string;
  readOnly: string;
  actorReporter: string;
  actorInvestigator: string;
  actorManager: string;
  statusOpen: string;
  statusAssigned: string;
  statusInReview: string;
  statusResolved: string;
  statusDismissed: string;
  categoryHarassment: string;
  categoryThreat: string;
  categorySpam: string;
  categoryPrivacy: string;
  categoryMisinformation: string;
  categoryOther: string;
  noticeAssigned: string;
  noticeReview: string;
  noticeResolved: string;
  noticeDismissed: string;
  errorGeneric: string;
  errorNetwork: string;
  errorAuth: string;
  errorConflict: string;
  errorInput: string;
  errorResponse: string;
  reportContextBefore: string;
  reportContextAfter: string;
  reportContextNone: string;
  reportContextOne: string;
  reportContextTwo: string;
  reportConsentLabel: string;
  reportConsentRequired: string;
}

const en: ModerationCopy = {
  eyebrow: 'SAFETY · SCOPED CASE REVIEW',
  title: 'Moderation cases',
  description: 'Assign designated investigators, review only consented case evidence, and close cases with an immutable reason and evidence reference.',
  privacyBoundary: 'Case managers see redacted queue metadata only. Message content is released only to the currently assigned, in-scope investigator. Reporter identity and unrelated conversations are never returned.',
  aal2Ready: 'Recent AAL2 required by the server',
  aal2Required: 'Verify with MFA to query or change moderation cases.',
  verifyNow: 'Verify with MFA',
  refresh: 'Refresh cases',
  refreshing: 'Refreshing…',
  loading: 'Loading scoped cases…',
  empty: 'No cases match this filter.',
  activeFilter: 'Active',
  openFilter: 'Unassigned',
  closedFilter: 'Closed',
  allFilter: 'All',
  protectedReporter: 'Reporter identity protected',
  scopedEvidence: 'Assigned evidence access',
  noContentList: 'Queue view contains no message content.',
  target: 'Reported target',
  targetMessage: 'Message',
  targetGroup: 'Group',
  targetMember: 'Person',
  claim: 'Claim',
  assign: 'Assign',
  reassign: 'Reassign',
  review: 'Start review',
  viewCase: 'Open case',
  resolve: 'Resolve',
  dismiss: 'Dismiss',
  close: 'Close',
  cancel: 'Cancel',
  submit: 'Confirm',
  working: 'Submitting…',
  actionReason: 'Operational reason',
  actionReasonPlaceholder: 'Explain the scoped decision without adding unrelated personal information.',
  investigator: 'Designated investigator',
  noEligibleInvestigator: 'No active investigator grant matches this case scope.',
  evidenceReference: 'Evidence references (optional, comma separated)',
  evidenceReferencePlaceholder: 'CASE-42, HR-17 — references only, no message text',
  policyCode: 'Policy code',
  policyCodePlaceholder: 'AUP.4.2',
  severity: 'Case severity',
  severityLow: 'Low',
  severityMedium: 'Medium',
  severityHigh: 'High',
  severityCritical: 'Critical',
  assignmentTitle: 'Assign designated investigator',
  assignmentDescription: 'Assignment grants access to this case only. The assignee must also retain a matching investigator scope.',
  claimTitle: 'Claim scoped case',
  claimDescription: 'Your active designated-investigator grant is the approval basis. A concurrent claim is rejected by version check.',
  reviewTitle: 'Begin case review',
  reviewDescription: 'This records that the assigned investigator began reviewing the immutable case snapshot.',
  resolveTitle: 'Resolve case',
  resolveDescription: 'Resolution closes the record permanently. Supply a reason and at least one policy, severity, or evidence reference.',
  dismissTitle: 'Dismiss case',
  dismissDescription: 'Dismissal closes the record permanently. Supply a reason and at least one policy, severity, or evidence reference.',
  caseReference: 'Case reference',
  reported: 'Reported',
  updated: 'Updated',
  assigned: 'Assigned',
  details: 'Reporter-provided details',
  detailsEmpty: 'No additional details were provided.',
  evidenceTitle: 'Consented evidence snapshot',
  evidenceDescription: 'Only the reported item and up to two consented messages on either side are available. The snapshot cannot be edited.',
  targetOnlyDescription: 'This report contains only the report-time target label and reporter-provided details. No group history, member status, profile fields, or messages were copied into the case.',
  evidenceReported: 'Reported item',
  evidenceBefore: 'Context before',
  evidenceAfter: 'Context after',
  attachmentEvidence: 'Attachment message (file content is not copied into this case view)',
  historyTitle: 'Immutable case history',
  historyDescription: 'Every assignment, evidence access, and lifecycle transition is recorded. Reporter actor identity is redacted.',
  readOnly: 'Closed · read-only',
  actorReporter: 'Protected reporter',
  actorInvestigator: 'Assigned investigator',
  actorManager: 'Authorized case manager',
  statusOpen: 'Open',
  statusAssigned: 'Assigned',
  statusInReview: 'In review',
  statusResolved: 'Resolved',
  statusDismissed: 'Dismissed',
  categoryHarassment: 'Harassment',
  categoryThreat: 'Threat',
  categorySpam: 'Spam',
  categoryPrivacy: 'Privacy',
  categoryMisinformation: 'Misinformation',
  categoryOther: 'Other',
  noticeAssigned: 'Case assignment recorded.',
  noticeReview: 'Case review started.',
  noticeResolved: 'Case resolved and locked read-only.',
  noticeDismissed: 'Case dismissed and locked read-only.',
  errorGeneric: 'The server rejected the moderation action. Refresh the case and try again.',
  errorNetwork: 'The moderation service is unavailable. The same dialog can retry safely with its idempotency key.',
  errorAuth: 'A valid session and recent MFA verification are required.',
  errorConflict: 'The case changed. Refresh before making another decision.',
  errorInput: 'Review the bounded reason, investigator, policy code, and evidence references.',
  errorResponse: 'The server returned an invalid moderation response. No action is treated as complete.',
  reportContextBefore: 'Share context before',
  reportContextAfter: 'Share context after',
  reportContextNone: 'None',
  reportContextOne: '1 message',
  reportContextTwo: '2 messages',
  reportConsentLabel: 'I understand and consent to this limited disclosure.',
  reportConsentRequired: 'Consent is required before this report can be submitted.',
};

const ko: ModerationCopy = {
  ...en,
  eyebrow: '안전 · 범위 제한 사례 검토',
  title: '조정 사례',
  description: '지정 조사관을 배정하고 동의된 사례 증거만 검토하며 변경 불가능한 사유와 증거 참조로 사례를 종료합니다.',
  privacyBoundary: '사례 관리자는 삭제된 대기열 메타데이터만 봅니다. 메시지 내용은 현재 배정되고 범위가 유효한 조사관에게만 제공됩니다. 신고자 신원과 관련 없는 대화는 반환되지 않습니다.',
  aal2Ready: '서버가 최근 AAL2 인증을 요구함',
  aal2Required: '조정 사례를 조회하거나 변경하려면 MFA로 인증하세요.',
  verifyNow: 'MFA로 인증',
  refresh: '사례 새로고침',
  refreshing: '새로고침 중…',
  loading: '범위 제한 사례 불러오는 중…',
  empty: '이 필터에 맞는 사례가 없습니다.',
  activeFilter: '활성', openFilter: '미배정', closedFilter: '종료', allFilter: '전체',
  protectedReporter: '신고자 신원 보호됨', scopedEvidence: '배정된 증거 접근',
  noContentList: '대기열 보기에는 메시지 내용이 없습니다.',
  target: '신고 대상', targetMessage: '메시지', targetGroup: '그룹', targetMember: '사람',
  claim: '가져오기', assign: '배정', reassign: '재배정', review: '검토 시작',
  viewCase: '사례 열기', resolve: '해결', dismiss: '기각', close: '닫기', cancel: '취소',
  submit: '확인', working: '제출 중…',
  actionReason: '운영 사유',
  actionReasonPlaceholder: '관련 없는 개인정보를 추가하지 말고 범위 제한 결정을 설명하세요.',
  investigator: '지정 조사관', noEligibleInvestigator: '이 사례 범위와 일치하는 활성 조사관 권한이 없습니다.',
  evidenceReference: '증거 참조 (선택, 쉼표로 구분)',
  evidenceReferencePlaceholder: 'CASE-42, HR-17 — 참조만 입력하고 메시지 본문은 제외',
  policyCode: '정책 코드', policyCodePlaceholder: 'AUP.4.2', severity: '사례 심각도',
  severityLow: '낮음', severityMedium: '중간', severityHigh: '높음', severityCritical: '매우 높음',
  assignmentTitle: '지정 조사관 배정',
  assignmentDescription: '배정은 이 사례에만 접근 권한을 부여합니다. 배정 대상은 일치하는 조사 범위를 계속 보유해야 합니다.',
  claimTitle: '범위 제한 사례 가져오기',
  claimDescription: '활성 지정 조사관 권한이 승인 근거입니다. 동시 가져오기는 버전 검사로 거부됩니다.',
  reviewTitle: '사례 검토 시작',
  reviewDescription: '배정된 조사관이 변경 불가능한 사례 스냅샷 검토를 시작했음을 기록합니다.',
  resolveTitle: '사례 해결',
  resolveDescription: '해결하면 기록이 영구 종료됩니다. 사유와 정책, 심각도 또는 증거 참조 중 하나 이상을 입력하세요.',
  dismissTitle: '사례 기각',
  dismissDescription: '기각하면 기록이 영구 종료됩니다. 사유와 정책, 심각도 또는 증거 참조 중 하나 이상을 입력하세요.',
  caseReference: '사례 참조', reported: '신고 시각', updated: '업데이트', assigned: '배정 시각',
  details: '신고자가 제공한 세부 정보', detailsEmpty: '추가 세부 정보가 제공되지 않았습니다.',
  evidenceTitle: '동의된 증거 스냅샷',
  evidenceDescription: '신고된 항목과 양쪽 최대 두 개의 동의된 메시지만 사용할 수 있습니다. 스냅샷은 수정할 수 없습니다.',
  targetOnlyDescription: '이 신고에는 신고 시점의 대상 레이블과 신고자가 제공한 세부 정보만 포함됩니다. 그룹 기록, 구성원 상태, 프로필 필드 또는 메시지는 사례에 복사되지 않습니다.',
  evidenceReported: '신고된 항목', evidenceBefore: '이전 맥락', evidenceAfter: '이후 맥락',
  attachmentEvidence: '첨부 메시지 (파일 내용은 이 사례 보기에 복사되지 않음)',
  historyTitle: '변경 불가능한 사례 기록',
  historyDescription: '모든 배정, 증거 접근 및 상태 전환이 기록됩니다. 신고자 행위자 신원은 삭제됩니다.',
  readOnly: '종료됨 · 읽기 전용', actorReporter: '보호된 신고자', actorInvestigator: '배정된 조사관', actorManager: '승인된 사례 관리자',
  statusOpen: '열림', statusAssigned: '배정됨', statusInReview: '검토 중', statusResolved: '해결됨', statusDismissed: '기각됨',
  categoryHarassment: '괴롭힘', categoryThreat: '위협', categorySpam: '스팸', categoryPrivacy: '개인정보 침해', categoryMisinformation: '허위 정보', categoryOther: '기타',
  noticeAssigned: '사례 배정이 기록되었습니다.', noticeReview: '사례 검토를 시작했습니다.',
  noticeResolved: '사례가 해결되어 읽기 전용으로 잠겼습니다.', noticeDismissed: '사례가 기각되어 읽기 전용으로 잠겼습니다.',
  errorGeneric: '서버가 조정 작업을 거부했습니다. 사례를 새로고침한 후 다시 시도하세요.',
  errorNetwork: '조정 서비스에 연결할 수 없습니다. 같은 대화상자에서 멱등성 키로 안전하게 재시도할 수 있습니다.',
  errorAuth: '유효한 세션과 최근 MFA 인증이 필요합니다.', errorConflict: '사례가 변경되었습니다. 다음 결정 전에 새로고침하세요.',
  errorInput: '제한된 사유, 조사관, 정책 코드 및 증거 참조를 확인하세요.',
  errorResponse: '서버가 잘못된 조정 응답을 반환했습니다. 어떤 작업도 완료된 것으로 처리하지 않습니다.',
  reportContextBefore: '이전 맥락 공유', reportContextAfter: '이후 맥락 공유',
  reportContextNone: '없음', reportContextOne: '메시지 1개', reportContextTwo: '메시지 2개',
  reportConsentLabel: '이 제한적 공개 내용을 이해했으며 이에 동의합니다.',
  reportConsentRequired: '이 신고를 제출하려면 동의가 필요합니다.',
};

const es: ModerationCopy = {
  ...en,
  eyebrow: 'SEGURIDAD · REVISIÓN LIMITADA',
  title: 'Casos de moderación',
  description: 'Asigna investigadores designados, revisa solo la evidencia consentida y cierra casos con un motivo y referencias inmutables.',
  privacyBoundary: 'Los gestores solo ven metadatos redactados de la cola. El contenido se entrega únicamente al investigador asignado con alcance vigente. Nunca se devuelve la identidad del informante ni conversaciones ajenas.',
  aal2Ready: 'El servidor exige AAL2 reciente',
  aal2Required: 'Verifica con MFA para consultar o cambiar casos.',
  verifyNow: 'Verificar con MFA', refresh: 'Actualizar casos', refreshing: 'Actualizando…',
  loading: 'Cargando casos limitados…', empty: 'Ningún caso coincide con este filtro.',
  activeFilter: 'Activos', openFilter: 'Sin asignar', closedFilter: 'Cerrados', allFilter: 'Todos',
  protectedReporter: 'Identidad del informante protegida', scopedEvidence: 'Acceso asignado a evidencia',
  noContentList: 'La cola no contiene texto de mensajes.',
  target: 'Objetivo informado', targetMessage: 'Mensaje', targetGroup: 'Grupo', targetMember: 'Persona',
  claim: 'Tomar', assign: 'Asignar', reassign: 'Reasignar', review: 'Iniciar revisión',
  viewCase: 'Abrir caso', resolve: 'Resolver', dismiss: 'Descartar', close: 'Cerrar', cancel: 'Cancelar',
  submit: 'Confirmar', working: 'Enviando…', actionReason: 'Motivo operativo',
  actionReasonPlaceholder: 'Explica la decisión limitada sin agregar información personal ajena.',
  investigator: 'Investigador designado', noEligibleInvestigator: 'No hay una concesión activa que coincida con el alcance del caso.',
  evidenceReference: 'Referencias de evidencia (opcionales, separadas por comas)',
  evidenceReferencePlaceholder: 'CASE-42, HR-17 — solo referencias, sin texto de mensajes',
  policyCode: 'Código de política', policyCodePlaceholder: 'AUP.4.2', severity: 'Gravedad del caso',
  severityLow: 'Baja', severityMedium: 'Media', severityHigh: 'Alta', severityCritical: 'Crítica',
  assignmentTitle: 'Asignar investigador designado',
  assignmentDescription: 'La asignación da acceso solo a este caso. La persona asignada también debe conservar un alcance de investigación compatible.',
  claimTitle: 'Tomar caso limitado',
  claimDescription: 'Tu concesión activa de investigador es la base de aprobación. Una toma simultánea se rechaza por versión.',
  reviewTitle: 'Iniciar revisión del caso',
  reviewDescription: 'Registra que el investigador asignado comenzó a revisar la instantánea inmutable.',
  resolveTitle: 'Resolver caso',
  resolveDescription: 'La resolución cierra el registro permanentemente. Proporciona un motivo y al menos una política, gravedad o referencia.',
  dismissTitle: 'Descartar caso',
  dismissDescription: 'El descarte cierra el registro permanentemente. Proporciona un motivo y al menos una política, gravedad o referencia.',
  caseReference: 'Referencia del caso', reported: 'Informado', updated: 'Actualizado', assigned: 'Asignado',
  details: 'Detalles aportados por el informante', detailsEmpty: 'No se proporcionaron detalles adicionales.',
  evidenceTitle: 'Instantánea de evidencia consentida',
  evidenceDescription: 'Solo están disponibles el elemento informado y hasta dos mensajes consentidos a cada lado. La instantánea no se puede editar.',
  targetOnlyDescription: 'Este informe solo contiene la etiqueta del objetivo en el momento del informe y los detalles aportados. No se copiaron historial del grupo, estado del miembro, campos de perfil ni mensajes.',
  evidenceReported: 'Elemento informado', evidenceBefore: 'Contexto anterior', evidenceAfter: 'Contexto posterior',
  attachmentEvidence: 'Mensaje con adjunto (el archivo no se copia en esta vista)',
  historyTitle: 'Historial inmutable',
  historyDescription: 'Se registra cada asignación, acceso a evidencia y transición. La identidad del informante está redactada.',
  readOnly: 'Cerrado · solo lectura', actorReporter: 'Informante protegido', actorInvestigator: 'Investigador asignado', actorManager: 'Gestor autorizado',
  statusOpen: 'Abierto', statusAssigned: 'Asignado', statusInReview: 'En revisión', statusResolved: 'Resuelto', statusDismissed: 'Descartado',
  categoryHarassment: 'Acoso', categoryThreat: 'Amenaza', categorySpam: 'Spam', categoryPrivacy: 'Privacidad', categoryMisinformation: 'Desinformación', categoryOther: 'Otro',
  noticeAssigned: 'Asignación registrada.', noticeReview: 'Revisión iniciada.',
  noticeResolved: 'Caso resuelto y bloqueado como solo lectura.', noticeDismissed: 'Caso descartado y bloqueado como solo lectura.',
  errorGeneric: 'El servidor rechazó la acción. Actualiza el caso e inténtalo de nuevo.',
  errorNetwork: 'El servicio no está disponible. Puedes reintentar con seguridad en el mismo diálogo.',
  errorAuth: 'Se requiere una sesión válida y una verificación MFA reciente.', errorConflict: 'El caso cambió. Actualiza antes de decidir.',
  errorInput: 'Revisa el motivo, investigador, código de política y referencias limitadas.',
  errorResponse: 'El servidor devolvió una respuesta inválida. Ninguna acción se considera completada.',
  reportContextBefore: 'Compartir contexto anterior', reportContextAfter: 'Compartir contexto posterior',
  reportContextNone: 'Ninguno', reportContextOne: '1 mensaje', reportContextTwo: '2 mensajes',
  reportConsentLabel: 'Entiendo y acepto esta divulgación limitada.',
  reportConsentRequired: 'Se requiere consentimiento antes de enviar este informe.',
};

export function moderationCopy(locale: LanguageCode): ModerationCopy {
  if (locale === 'ko') return ko;
  if (locale === 'es') return es;
  return en;
}

export function moderationReportConsentNotice(
  locale: LanguageCode,
  contextBefore: 0 | 1 | 2,
  contextAfter: 0 | 1 | 2,
): string {
  if (locale === 'ko') {
    return `제출하면 선택한 메시지와 이전 ${contextBefore}개, 이후 ${contextAfter}개의 메시지가 지정 조사관에게 공유됩니다. 신고 대상자에게는 신고자 신원이 보호되지만, 승인된 사례 서비스는 안전 및 감사를 위해 신원을 비공개로 저장합니다.`;
  }
  if (locale === 'es') {
    return `Al enviar, compartes el mensaje seleccionado, ${contextBefore} anterior(es) y ${contextAfter} posterior(es) con investigadores designados. La identidad del informante se protege frente a la persona denunciada, pero los servicios autorizados del caso la almacenan de forma privada por seguridad y auditoría.`;
  }
  return `Submitting shares the selected message and ${contextBefore} before/${contextAfter} after with designated investigators. Reporter identity is protected from the reported person, but authorized case services store it privately for safety/audit.`;
}

export function moderationTargetReportConsentNotice(
  locale: LanguageCode,
  targetType: 'group' | 'member',
): string {
  if (locale === 'ko') {
    return targetType === 'group'
      ? '제출하면 신고 시점의 그룹 이름과 입력한 세부 정보만 지정 조사관에게 공유됩니다. 그룹 메시지 기록은 공유되지 않습니다. 그룹 구성원에게는 신고 사실이나 신고자 신원이 통지되지 않으며, 승인된 사례 서비스만 안전 및 감사를 위해 신원을 비공개로 저장합니다.'
      : '제출하면 신고 시점의 표시 이름과 입력한 세부 정보만 지정 조사관에게 공유됩니다. 계정 상태, 프로필 필드, 대화 또는 메시지는 공유되지 않습니다. 신고 대상자에게는 신고 사실이나 신고자 신원이 통지되지 않으며, 승인된 사례 서비스만 안전 및 감사를 위해 신원을 비공개로 저장합니다.';
  }
  if (locale === 'es') {
    return targetType === 'group'
      ? 'Al enviar, solo se comparte con investigadores designados el nombre del grupo en ese momento y los detalles que escribiste. No se comparte el historial de mensajes. Los miembros no reciben aviso del informe ni la identidad del informante; solo los servicios autorizados la guardan de forma privada por seguridad y auditoría.'
      : 'Al enviar, solo se comparte con investigadores designados el nombre visible de la persona en ese momento y los detalles que escribiste. No se comparten estado de cuenta, perfil, conversaciones ni mensajes. La persona no recibe aviso del informe ni la identidad del informante; solo los servicios autorizados la guardan de forma privada por seguridad y auditoría.';
  }
  return targetType === 'group'
    ? 'Submitting shares only the group name at report time and the details you provide with designated investigators. Group message history is not shared. Members are not notified of the report or reporter identity; authorized case services store identity privately for safety and audit.'
    : 'Submitting shares only the person’s display label at report time and the details you provide with designated investigators. Account status, profile fields, conversations, and messages are not shared. The person is not notified of the report or reporter identity; authorized case services store identity privately for safety and audit.';
}

export function moderationMemberSafetyRouteNotice(locale: LanguageCode): string {
  if (locale === 'ko') {
    return '차단하거나 계정이 비활성화되어 일반 메시지를 보낼 수 없더라도, 수락된 연락처 또는 과거 공유 대화가 있으면 비공개 안전 신고 경로가 유지됩니다. 이 경로의 제공 여부는 상대방의 현재 계정 상태를 공개하지 않습니다.';
  }
  if (locale === 'es') {
    return 'Aunque el bloqueo o la salida de una cuenta impidan la mensajería normal, la vía privada de seguridad permanece disponible para un contacto aceptado o un historial de conversación compartida. Su disponibilidad no revela el estado actual de la cuenta de la otra persona.';
  }
  return 'Even when blocking or account departure removes ordinary messaging, the private safety route remains available for an accepted contact or shared-conversation history. Its availability does not reveal the other person’s current account status.';
}
