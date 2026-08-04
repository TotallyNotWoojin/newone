import type { AppLocale } from '@/i18n/catalog';

const en = {
  title: 'Confirm handoff acknowledgement',
  description: 'Confirm the exact immutable version you reviewed. Add an optional discrepancy note if anything needs follow-up; acknowledgement does not edit the handoff.',
  exactVersion: 'Exact version being acknowledged',
  discrepancyNote: 'Discrepancy note (optional)',
  discrepancyPlaceholder: 'Record a discrepancy or follow-up without changing this version',
  discrepancyHint: 'Optional and audit-recorded · up to 2,000 characters',
  tooLong: 'Keep the discrepancy note within 2,000 characters.',
  confirm: 'Acknowledge exact version',
  version: 'Version',
} as const;

type HandoffAcknowledgementCopy = { [Key in keyof typeof en]: string };

const ko: HandoffAcknowledgementCopy = {
  title: '인수인계 확인 승인',
  description: '검토한 변경 불가능한 정확한 버전을 확인하세요. 후속 조치가 필요한 내용은 선택적 불일치 메모로 남길 수 있으며, 확인 승인은 인수인계를 수정하지 않습니다.',
  exactVersion: '확인 승인할 정확한 버전',
  discrepancyNote: '불일치 메모 (선택 사항)',
  discrepancyPlaceholder: '이 버전을 변경하지 않고 불일치 또는 후속 조치를 기록하세요',
  discrepancyHint: '선택 사항 및 감사 기록 · 최대 2,000자',
  tooLong: '불일치 메모를 2,000자 이내로 작성하세요.',
  confirm: '정확한 버전 확인 승인',
  version: '버전',
};

const es: HandoffAcknowledgementCopy = {
  title: 'Confirmar recepción de la entrega',
  description: 'Confirma la versión inmutable exacta que revisaste. Puedes añadir una nota opcional de discrepancia para seguimiento; la confirmación no modifica la entrega.',
  exactVersion: 'Versión exacta que se confirma',
  discrepancyNote: 'Nota de discrepancia (opcional)',
  discrepancyPlaceholder: 'Registra una discrepancia o seguimiento sin cambiar esta versión',
  discrepancyHint: 'Opcional y auditada · hasta 2.000 caracteres',
  tooLong: 'Limita la nota de discrepancia a 2.000 caracteres.',
  confirm: 'Confirmar versión exacta',
  version: 'Versión',
};

const copy: Record<AppLocale, HandoffAcknowledgementCopy> = { en, ko, es };

export function handoffAcknowledgementCopy(locale: AppLocale) {
  return copy[locale];
}
