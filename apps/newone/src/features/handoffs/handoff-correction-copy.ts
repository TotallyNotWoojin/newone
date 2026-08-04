import type { AppLocale } from '@/i18n/catalog';

const en = {
  correct: 'Correct handoff',
  correctionTitle: 'Create a corrected handoff version',
  correctionDescription: 'This creates a new immutable draft. The prior version and its evidence remain auditable, while signatures, acknowledgements, reminders, and escalation do not carry forward.',
  version: 'Version',
  exactVersion: 'Exact version being corrected',
  createsVersion: 'Creates draft version',
  exactSources: 'Exact source-message set',
  exactSourcesHint: 'Select every message that supports the corrected record. Unloaded source IDs remain selectable and are verified by the server.',
  sourceId: 'Source message',
  openSource: 'Open source message',
  deadline: 'Exact acknowledgement deadline (ISO date/time)',
  noDeadline: 'No acknowledgement deadline',
  reason: 'Correction reason',
  reasonPlaceholder: 'What was wrong, what changed, and why',
  reasonHint: 'Required and audit-recorded · 3–2,000 characters',
  publish: 'Create corrected draft',
  invalid: 'Enter valid shift times, keep at least one exact source, place the deadline after the shift, and provide a correction reason.',
  correctedFrom: 'Corrected from',
  signatureReset: 'New signature required',
} as const;

type HandoffCorrectionCopy = { [Key in keyof typeof en]: string };

const ko: HandoffCorrectionCopy = {
  correct: '인수인계 수정',
  correctionTitle: '수정된 인수인계 버전 만들기',
  correctionDescription: '새로운 변경 불가능한 초안이 생성됩니다. 이전 버전과 근거는 감사 기록으로 유지되지만 서명, 확인, 알림 및 에스컬레이션은 이어지지 않습니다.',
  version: '버전',
  exactVersion: '수정할 정확한 버전',
  createsVersion: '생성될 초안 버전',
  exactSources: '정확한 출처 메시지 집합',
  exactSourcesHint: '수정 기록을 뒷받침하는 모든 메시지를 선택하세요. 아직 불러오지 않은 출처 ID도 선택 상태로 유지되며 서버에서 검증됩니다.',
  sourceId: '출처 메시지',
  openSource: '출처 메시지 열기',
  deadline: '정확한 확인 기한 (ISO 날짜/시간)',
  noDeadline: '확인 기한 없음',
  reason: '수정 사유',
  reasonPlaceholder: '잘못된 내용, 변경한 내용 및 그 이유',
  reasonHint: '필수 감사 기록 · 3~2,000자',
  publish: '수정 초안 만들기',
  invalid: '올바른 교대 시간을 입력하고 정확한 출처를 하나 이상 유지하며, 확인 기한을 교대 종료 후로 설정하고 수정 사유를 작성하세요.',
  correctedFrom: '수정한 이전 버전',
  signatureReset: '새 서명 필요',
};

const es: HandoffCorrectionCopy = {
  correct: 'Corregir entrega',
  correctionTitle: 'Crear una versión corregida de la entrega',
  correctionDescription: 'Esto crea un borrador nuevo e inmutable. La versión anterior y su evidencia siguen auditables; las firmas, confirmaciones, recordatorios y escalados no se transfieren.',
  version: 'Versión',
  exactVersion: 'Versión exacta que se corrige',
  createsVersion: 'Crea la versión borrador',
  exactSources: 'Conjunto exacto de mensajes fuente',
  exactSourcesHint: 'Selecciona todos los mensajes que respaldan el registro corregido. Los identificadores aún no cargados siguen seleccionables y el servidor los verifica.',
  sourceId: 'Mensaje fuente',
  openSource: 'Abrir mensaje fuente',
  deadline: 'Plazo exacto de confirmación (fecha/hora ISO)',
  noDeadline: 'Sin plazo de confirmación',
  reason: 'Motivo de la corrección',
  reasonPlaceholder: 'Qué estaba mal, qué cambió y por qué',
  reasonHint: 'Obligatorio y auditado · 3–2.000 caracteres',
  publish: 'Crear borrador corregido',
  invalid: 'Introduce horarios válidos, conserva al menos una fuente exacta, fija el plazo después del turno y explica el motivo de la corrección.',
  correctedFrom: 'Corregida desde',
  signatureReset: 'Requiere una firma nueva',
};

const copy: Record<AppLocale, HandoffCorrectionCopy> = { en, ko, es };

export function handoffCorrectionCopy(locale: AppLocale) {
  return copy[locale];
}
