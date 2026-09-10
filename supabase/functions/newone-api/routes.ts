import type { AuthenticatedActor } from '../_shared/clients.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { protectPushToken } from '../_shared/device-secrets.ts';
import {
  signConversationMemberCandidateCursor,
  verifyConversationMemberCandidateCursor,
} from '../_shared/cursors.ts';
import { isSingleEmoji } from '../_shared/emoji.ts';
import { fetchLinkPreview, fetchPreviewImage, normalizePreviewUrl } from '../_shared/link-preview.ts';

/**
 * Swap our stored thumbnail path for a short-lived signed link, and never send
 * the remote address on: the phone must not be the thing that fetches it.
 */
async function withSignedPreviewImage(
  actor: AuthenticatedActor,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { image_path: imagePath, image_url: _remote, ...rest } = row;
  if (typeof imagePath !== 'string' || !imagePath) return { ...rest, image_url: null };
  const { data } = await actor.adminClient.storage
    .from(LINK_PREVIEW_IMAGE_BUCKET)
    .createSignedUrl(imagePath, LINK_PREVIEW_IMAGE_SECONDS);
  // One unsigned thumbnail is a preview without a picture, never a failure.
  return { ...rest, image_url: data?.signedUrl ?? null };
}

/** Our own copy of a page's thumbnail: private, and served signed. */
const LINK_PREVIEW_IMAGE_BUCKET = 'link-preview-images';
const LINK_PREVIEW_IMAGE_SECONDS = 60 * 60;
import { ApiError } from '../_shared/errors.ts';
import { expoPushToken } from '../_shared/expo-push.ts';
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import { beginIdempotency, completeIdempotency } from '../_shared/security.ts';
import {
  asObject,
  bool,
  integer,
  isoDate,
  type JsonObject,
  normalizedString,
  oneOf,
  onlyKeys,
  optionalBool,
  optionalInteger,
  optionalOneOf,
  optionalString,
  optionalUuid,
  optionalUuidArray,
  requiredString,
  requiredUuid,
  uuid,
  uuidArray,
} from '../_shared/validation.ts';

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** "en-US-u-hc-h23" → "en-US"; "ko_KR" → "ko-KR"; anything else unusable → null. */
export function normalizeLocaleTag(value: string): string | null {
  const core = value.trim().replace(/_/g, '-').split(/-(?:u|x|t)(?:-|$)/i)[0] ?? '';
  if (core.length < 2 || core.length > 35) return null;
  const [language = '', ...rest] = core.split('-');
  const tag = [language.toLowerCase(), ...rest].join('-');
  return LANGUAGE_PATTERN.test(tag) ? tag : null;
}
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
]);
// Video containers carry their own 100 MiB cap; every other attachment type
// keeps the 25 MiB cap. The database grant function and the row constraint
// enforce the same per-type discipline.
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
const ATTACHMENT_MAX_BYTES = 26214400;
const VIDEO_ATTACHMENT_MAX_BYTES = 104857600;
const CONVERSATION_AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONVERSATION_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export type RouteKind =
  | 'conversation.direct'
  | 'conversation.group'
  | 'conversation.group.candidates'
  | 'conversation.member.candidates'
  | 'conversation.update'
  | 'conversation.preferences.update'
  | 'conversation.controls.update'
  | 'organization.preferences.update'
  | 'conversation.member.add'
  | 'conversation.member.remove'
  | 'conversation.member.role.update'
  | 'conversation.avatar.grant'
  | 'conversation.avatar.query'
  | 'conversation.avatar.activate'
  | 'conversation.avatar.remove'
  | 'profile.avatar.grant'
  | 'profile.avatar.query'
  | 'profile.avatar.activate'
  | 'profile.avatar.remove'
  | 'conversation.leave'
  | 'message.send'
  | 'message.edit'
  | 'message.react'
  | 'message.report'
  | 'conversation.report'
  | 'member.report'
  | 'message.translate'
  | 'message.pin'
  | 'message.receipt'
  | 'message.hide_for_me'
  | 'message.link_preview'
  | 'message.forward'
  | 'translation.correction.propose'
  | 'translation.correction.review'
  | 'summary.request'
  | 'summary.manual.create'
  | 'ai_output.error.report'
  | 'ai_output.error_reports.self.query'
  | 'profile.update'
  | 'contact.request'
  | 'contact.message_request'
  | 'contact.respond'
  | 'contact.cancel'
  | 'saved_contact.update'
  | 'saved_contact.remove'
  | 'member.block'
  | 'member.unblock'
  | 'person.mute'
  | 'person.unmute'
  | 'handoff.sign'
  | 'handoff.acknowledge'
  | 'action.confirm'
  | 'attachment.grant'
  | 'attachment.complete'
  | 'attachment.state'
  | 'device.register'
  | 'device.preferences.read'
  | 'device.preferences.update'
  | 'device.mute.read'
  | 'device.mute.update'
  | 'session.list'
  | 'session.revoke.self'
  | 'audit.export';

export interface MatchedRoute {
  kind: RouteKind;
  template: string;
  params: Record<string, string>;
  status: number;
  requireAal2?: boolean;
  recentAuthSeconds?: number;
  idempotencyRequired?: boolean;
}

export interface ParsedCommand {
  organizationId: string;
  values: JsonObject;
}

export interface CommandResult {
  status: number;
  body: unknown;
}

function matchPattern(path: string, pattern: string): Record<string, string> | null {
  const actualParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (actualParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] as string;
    const actual = actualParts[index] as string;
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) return null;
  }
  return params;
}

const ROUTES: Array<Omit<MatchedRoute, 'params'> & { method: string }> = [
  {
    method: 'POST',
    kind: 'conversation.direct',
    template: '/v2/conversations/direct',
    status: 201,
  },
  { method: 'POST', kind: 'conversation.group', template: '/v2/conversations/group', status: 201 },
  {
    method: 'POST',
    kind: 'conversation.group.candidates',
    template: '/v2/conversations/group/candidates/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'POST',
    kind: 'conversation.member.candidates',
    template: '/v2/conversations/:conversationId/member-candidates/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'PATCH',
    kind: 'conversation.update',
    template: '/v2/conversations/:conversationId',
    status: 200,
  },
  {
    method: 'PATCH',
    kind: 'conversation.preferences.update',
    template: '/v2/conversations/:conversationId/preferences',
    status: 200,
  },
  {
    method: 'PATCH',
    kind: 'organization.preferences.update',
    template: '/v2/preferences/organization',
    status: 200,
  },
  {
    method: 'PATCH',
    kind: 'conversation.controls.update',
    template: '/v2/conversations/:conversationId/controls',
    status: 200,
    requireAal2: true,
    recentAuthSeconds: 300,
  },
  {
    method: 'POST',
    kind: 'conversation.member.add',
    template: '/v2/conversations/:conversationId/members',
    status: 201,
  },
  {
    method: 'DELETE',
    kind: 'conversation.member.remove',
    template: '/v2/conversations/:conversationId/members/:membershipId',
    status: 200,
  },
  {
    method: 'PATCH',
    kind: 'conversation.member.role.update',
    template: '/v2/conversations/:conversationId/members/:membershipId/role',
    status: 200,
    requireAal2: true,
    recentAuthSeconds: 900,
  },
  {
    method: 'POST',
    kind: 'conversation.avatar.grant',
    template: '/v2/conversations/:conversationId/avatar/grants',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'conversation.avatar.query',
    template: '/v2/conversations/:conversationId/avatar/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'POST',
    kind: 'conversation.avatar.activate',
    template: '/v2/conversations/:conversationId/avatar/:attachmentId/activate',
    status: 200,
  },
  {
    method: 'DELETE',
    kind: 'conversation.avatar.remove',
    template: '/v2/conversations/:conversationId/avatar',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'conversation.leave',
    template: '/v2/conversations/:conversationId/leave',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'message.send',
    template: '/v2/conversations/:conversationId/messages',
    status: 201,
  },
  { method: 'PATCH', kind: 'message.edit', template: '/v2/messages/:messageId', status: 200 },
  {
    method: 'POST',
    kind: 'message.react',
    template: '/v2/messages/:messageId/reactions',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'message.report',
    template: '/v2/messages/:messageId/report',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'conversation.report',
    template: '/v2/conversations/:conversationId/report',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'member.report',
    template: '/v2/people/:membershipId/report',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'message.translate',
    template: '/v2/messages/:messageId/translations',
    status: 202,
  },
  { method: 'POST', kind: 'message.pin', template: '/v2/messages/:messageId/pin', status: 200 },
  {
    method: 'POST',
    kind: 'message.receipt',
    template: '/v2/messages/:messageId/receipt',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'message.hide_for_me',
    template: '/v2/messages/:messageId/hide',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'message.link_preview',
    template: '/v2/link-previews/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'POST',
    kind: 'message.forward',
    template: '/v2/messages/:messageId/forward',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'translation.correction.propose',
    template: '/v2/messages/:messageId/translations/:targetLanguage/corrections',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'translation.correction.review',
    template: '/v2/translation-corrections/:correctionId/review',
    status: 201,
    requireAal2: true,
    recentAuthSeconds: 900,
  },
  {
    method: 'POST',
    kind: 'summary.request',
    template: '/v2/conversations/:conversationId/summaries',
    status: 202,
  },
  {
    method: 'POST',
    kind: 'summary.manual.create',
    template: '/v2/conversations/:conversationId/summaries/manual',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'ai_output.error.report',
    template: '/v2/ai-output-error-reports',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'ai_output.error_reports.self.query',
    template: '/v2/ai-output-error-reports/self/query',
    status: 200,
    idempotencyRequired: false,
  },
  { method: 'PATCH', kind: 'profile.update', template: '/v2/profile', status: 200 },
  { method: 'POST', kind: 'profile.avatar.grant', template: '/v2/profile/avatar/grants', status: 201 },
  {
    method: 'POST',
    kind: 'profile.avatar.query',
    template: '/v2/profiles/:userId/avatar/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'POST',
    kind: 'profile.avatar.activate',
    template: '/v2/profile/avatar/:uploadId/activate',
    status: 200,
  },
  { method: 'DELETE', kind: 'profile.avatar.remove', template: '/v2/profile/avatar', status: 200 },
  { method: 'POST', kind: 'contact.request', template: '/v2/contacts/connections', status: 201 },
  {
    method: 'POST',
    kind: 'contact.message_request',
    template: '/v2/contacts/message-requests',
    status: 201,
  },
  {
    method: 'POST',
    kind: 'contact.respond',
    template: '/v2/contacts/connections/:membershipId/respond',
    status: 200,
  },
  {
    method: 'DELETE',
    kind: 'contact.cancel',
    template: '/v2/contacts/connections/:membershipId',
    status: 200,
  },
  {
    method: 'PATCH',
    kind: 'saved_contact.update',
    template: '/v2/contacts/saved/:membershipId',
    status: 200,
  },
  {
    method: 'DELETE',
    kind: 'saved_contact.remove',
    template: '/v2/contacts/saved/:membershipId',
    status: 200,
  },
  {
    method: 'PUT',
    kind: 'member.block',
    template: '/v2/people/:membershipId/block',
    status: 200,
  },
  {
    method: 'DELETE',
    kind: 'member.unblock',
    template: '/v2/people/:membershipId/block',
    status: 200,
  },
  {
    method: 'PUT',
    kind: 'person.mute',
    template: '/v2/people/:membershipId/mute',
    status: 200,
  },
  {
    method: 'DELETE',
    kind: 'person.unmute',
    template: '/v2/people/:membershipId/mute',
    status: 200,
  },
  { method: 'POST', kind: 'attachment.grant', template: '/v2/attachments/grants', status: 201 },
  {
    method: 'POST',
    kind: 'attachment.complete',
    template: '/v2/attachments/:attachmentId/complete',
    status: 202,
  },
  {
    method: 'POST',
    kind: 'attachment.state',
    template: '/v2/attachments/:attachmentId/state',
    status: 200,
    idempotencyRequired: false,
  },
  { method: 'POST', kind: 'device.register', template: '/v2/devices', status: 200 },
  {
    method: 'POST',
    kind: 'device.preferences.read',
    template: '/v2/devices/:installationId/preferences/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'PATCH',
    kind: 'device.preferences.update',
    template: '/v2/devices/:installationId/preferences',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'device.mute.read',
    template: '/v2/devices/:installationId/mute/query',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'PATCH',
    kind: 'device.mute.update',
    template: '/v2/devices/:installationId/mute',
    status: 200,
  },
  {
    method: 'POST',
    kind: 'session.list',
    template: '/v2/auth/sessions/list',
    status: 200,
    idempotencyRequired: false,
  },
  {
    method: 'POST',
    kind: 'session.revoke.self',
    template: '/v2/auth/sessions/:sessionId/revoke',
    status: 200,
  },
];

export function apiPath(url: string): string {
  const pathname = new URL(url).pathname;
  const marker = pathname.indexOf('/v2/');
  if (marker < 0) return pathname === '/v2' ? '/v2' : pathname;
  return pathname.slice(marker);
}

export function matchRoute(method: string, path: string): MatchedRoute | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPattern(path, route.template);
    if (params) return { ...route, params };
  }
  return null;
}

function organization(body: JsonObject): string {
  return requiredUuid(body, 'organizationId');
}

function language(value: unknown): string {
  const result = normalizedString(value, { min: 2, max: 35 }) as string;
  if (!LANGUAGE_PATTERN.test(result)) throw new ApiError(400, 'bad_request');
  return result;
}

function messageId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ApiError(400, 'bad_request');
  }
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(400, 'bad_request');
  return text;
}

function optionalMessageId(body: JsonObject, key: string): string | null {
  if (!(key in body) || body[key] === null) return null;
  return messageId(body[key]);
}

function pathUuid(route: MatchedRoute, key: string): string {
  return uuid(route.params[key]);
}

function pathMessageId(route: MatchedRoute): string {
  return messageId(route.params.messageId);
}

function nullableIsoDate(body: JsonObject, key: string): string | null {
  return body[key] === null || body[key] === undefined ? null : isoDate(body[key]);
}

function quietTime(value: unknown): string | null {
  if (value === null) return null;
  const result = normalizedString(value, { min: 5, max: 8 }) as string;
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/.test(result)) {
    throw new ApiError(400, 'bad_request');
  }
  return result;
}

function membershipRoles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new ApiError(400, 'bad_request');
  }
  const roles = value.map((role) => oneOf(role, ['owner', 'admin', 'manager', 'member'] as const));
  if (new Set(roles).size !== roles.length) throw new ApiError(400, 'bad_request');
  return roles;
}

function dynamicGroupPolicySpec(value: unknown): JsonObject {
  const input = asObject(value);
  onlyKeys(input, [
    'siteIds',
    'departmentIds',
    'teamIds',
    'lineIds',
    'unitIds',
    'includeDescendants',
    'operationalRoles',
    'membershipRoles',
    'shiftMode',
    'scheduledShiftStartsAt',
    'scheduledShiftEndsAt',
  ]);
  if (Object.keys(input).length !== 11) throw new ApiError(400, 'bad_request');
  const canonicalUuidArray = (entry: unknown) => uuidArray(entry, 100).sort();
  const operationalRoles = boundedTextArray(input.operationalRoles, 50, 160)
    .map((role) => role.toLocaleLowerCase('en-US'))
    .sort();
  if (new Set(operationalRoles).size !== operationalRoles.length) {
    throw new ApiError(400, 'bad_request');
  }
  const accessRoles = membershipRoles(input.membershipRoles).sort();
  const shiftMode = oneOf(input.shiftMode, ['none', 'current', 'scheduled'] as const);
  const scheduledShiftStartsAt = input.scheduledShiftStartsAt === null
    ? null
    : isoDate(input.scheduledShiftStartsAt);
  const scheduledShiftEndsAt = input.scheduledShiftEndsAt === null
    ? null
    : isoDate(input.scheduledShiftEndsAt);
  if (
    (shiftMode !== 'scheduled' &&
      (scheduledShiftStartsAt !== null || scheduledShiftEndsAt !== null)) ||
    (shiftMode === 'scheduled' &&
      (scheduledShiftStartsAt === null || scheduledShiftEndsAt === null ||
        Date.parse(scheduledShiftEndsAt) <= Date.parse(scheduledShiftStartsAt) ||
        Date.parse(scheduledShiftEndsAt) - Date.parse(scheduledShiftStartsAt) >
          31 * 24 * 60 * 60 * 1000))
  ) throw new ApiError(400, 'bad_request');
  return {
    site_ids: canonicalUuidArray(input.siteIds),
    department_ids: canonicalUuidArray(input.departmentIds),
    team_ids: canonicalUuidArray(input.teamIds),
    line_ids: canonicalUuidArray(input.lineIds),
    unit_ids: canonicalUuidArray(input.unitIds),
    include_descendants: bool(input.includeDescendants),
    operational_roles: operationalRoles,
    membership_roles: accessRoles,
    shift_mode: shiftMode,
    scheduled_shift_starts_at: scheduledShiftStartsAt,
    scheduled_shift_ends_at: scheduledShiftEndsAt,
  };
}

function announcementAudienceSpec(value: unknown): JsonObject {
  const input = asObject(value);
  onlyKeys(input, [
    'company',
    'conversationMembers',
    'siteIds',
    'departmentIds',
    'teamIds',
    'unitIds',
    'operationalRoles',
    'membershipRoles',
    'languages',
    'currentShiftOnly',
  ]);
  const operationalRoles = boundedTextArray(input.operationalRoles ?? [], 50, 160)
    .map((role) => role.toLocaleLowerCase('en-US'));
  const accessRoles = Array.isArray(input.membershipRoles)
    ? input.membershipRoles.map((role) =>
      oneOf(role, ['owner', 'admin', 'manager', 'member'] as const)
    )
    : [];
  const languages = Array.isArray(input.languages)
    ? input.languages.map((entry) =>
      language(
        typeof entry === 'string' ? entry.toLocaleLowerCase('en-US') : entry,
      ).toLocaleLowerCase('en-US')
    )
    : [];
  if (
    new Set(operationalRoles).size !== operationalRoles.length ||
    new Set(accessRoles).size !== accessRoles.length ||
    new Set(languages).size !== languages.length ||
    languages.length > 20
  ) throw new ApiError(400, 'bad_request');
  return {
    company: optionalBool(input, 'company') ?? false,
    conversation_members: optionalBool(input, 'conversationMembers') ?? false,
    site_ids: optionalUuidArray(input, 'siteIds', 100) ?? [],
    department_ids: optionalUuidArray(input, 'departmentIds', 100) ?? [],
    team_ids: optionalUuidArray(input, 'teamIds', 100) ?? [],
    unit_ids: optionalUuidArray(input, 'unitIds', 100) ?? [],
    roles: operationalRoles,
    membership_roles: accessRoles,
    languages,
    current_shift_only: optionalBool(input, 'currentShiftOnly') ?? false,
  };
}

// The ranges a reader can pick for a summary; the server resolves them.
const SUMMARY_RANGE_KINDS = ['unread', 'today', 'yesterday', 'last_7_days', 'everything'] as const;

function messageIdArray(value: unknown, maximum = 500): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ApiError(400, 'bad_request');
  }
  const ids = value.map((entry) => {
    const text = typeof entry === 'number' || typeof entry === 'string' ? String(entry) : '';
    if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(400, 'bad_request');
    return text;
  });
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'bad_request');
  return ids;
}

function boundedTextArray(
  value: unknown,
  maximumItems: number,
  maximumTextLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ApiError(400, 'bad_request');
  }
  return value.map((entry) =>
    normalizedString(entry, {
      min: 1,
      max: maximumTextLength,
      trim: true,
    }) as string
  );
}

const AI_USE_CASES = ['language_detection', 'translation', 'summary'] as const;
const AI_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,159}$/;

function aiUseCaseArray(value: unknown): Array<typeof AI_USE_CASES[number]> {
  if (!Array.isArray(value) || value.length > AI_USE_CASES.length) {
    throw new ApiError(400, 'bad_request');
  }
  const useCases = value.map((entry) => oneOf(entry, AI_USE_CASES));
  if (new Set(useCases).size !== useCases.length) throw new ApiError(400, 'bad_request');
  return [...useCases].sort();
}

function aiProviderArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'bad_request');
  const providers = value.map((entry) => {
    if (typeof entry !== 'string' || !AI_PROVIDER_PATTERN.test(entry)) {
      throw new ApiError(400, 'bad_request');
    }
    return entry;
  });
  if (new Set(providers).size !== providers.length) throw new ApiError(400, 'bad_request');
  return [...providers].sort();
}

function summaryEvidenceArray(
  value: unknown,
  sourceMessageIds: ReadonlySet<string>,
  kind: 'decision' | 'action',
): JsonObject[] {
  if (!Array.isArray(value) || value.length > 100) throw new ApiError(400, 'bad_request');
  return value.map((entry) => {
    const row = asObject(entry);
    onlyKeys(
      row,
      kind === 'action'
        ? ['text', 'sourceMessageIds', 'owner', 'due']
        : ['text', 'sourceMessageIds'],
    );
    const evidenceIds = messageIdArray(row.sourceMessageIds, 50);
    if (!evidenceIds.length || evidenceIds.some((id) => !sourceMessageIds.has(id))) {
      throw new ApiError(400, 'bad_request');
    }
    const result: JsonObject = {
      text: requiredString(row, 'text', { min: 1, max: 2000 }),
      source_message_ids: evidenceIds,
    };
    if (kind === 'action') {
      result.owner = optionalString(row, 'owner', { max: 240, nullable: true }) ?? null;
      result.due = optionalString(row, 'due', { max: 240, nullable: true }) ?? null;
    }
    return result;
  });
}

function requiredKeyArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'bad_request');
  const keys = value.map((entry) => {
    const key = normalizedString(entry, { min: 1, max: 64 }) as string;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new ApiError(400, 'bad_request');
    return key;
  });
  if (new Set(keys).size !== keys.length) throw new ApiError(400, 'bad_request');
  return keys;
}

const AUDIT_REASON_CODES = [
  'security_review',
  'compliance_review',
  'incident_investigation',
  'access_review',
] as const;
const AUDIT_EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;
const AUDIT_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;

function auditEventTypes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new ApiError(400, 'bad_request');
  const result = value.map((entry) => normalizedString(entry, { min: 3, max: 120 }) as string);
  if (
    new Set(result).size !== result.length ||
    result.some((eventType) => !AUDIT_EVENT_PATTERN.test(eventType))
  ) throw new ApiError(400, 'bad_request');
  return result;
}

function acknowledgementSchema(value: unknown): JsonObject {
  const schema = asObject(value);
  onlyKeys(schema, [
    'schemaVersion',
    'attestationRequired',
    'attestationPrompt',
    'requiredKeys',
    'carryForwardOnCorrection',
  ]);
  if (integer(schema.schemaVersion, 1, 1) !== 1) throw new ApiError(400, 'bad_request');
  const attestationRequired = bool(schema.attestationRequired);
  const attestationPrompt = schema.attestationPrompt === null
    ? null
    : normalizedString(schema.attestationPrompt, { min: 3, max: 500 }) as string;
  const requiredKeys = requiredKeyArray(schema.requiredKeys);
  const carryForwardOnCorrection = bool(schema.carryForwardOnCorrection);
  if (
    attestationRequired
      ? attestationPrompt === null || requiredKeys.length === 0
      : attestationPrompt !== null || requiredKeys.length !== 0
  ) throw new ApiError(400, 'bad_request');
  return {
    schema_version: 1,
    attestation_required: attestationRequired,
    attestation_prompt: attestationPrompt,
    required_keys: requiredKeys,
    carry_forward_on_correction: carryForwardOnCorrection,
  };
}

function reminderPolicy(value: unknown, scheduledAt: string | null): JsonObject {
  const policy = asObject(value);
  onlyKeys(policy, [
    'enabled',
    'deadlineAt',
    'intervalSeconds',
    'maximumReminders',
    'escalateAfterSeconds',
    'smsFallback',
  ]);
  const enabled = bool(policy.enabled);
  const deadlineAt = policy.deadlineAt === null ? null : isoDate(policy.deadlineAt);
  const intervalSeconds = policy.intervalSeconds === null
    ? null
    : integer(policy.intervalSeconds, 300, 604800);
  const maximumReminders = integer(policy.maximumReminders, 0, 20);
  const escalateAfterSeconds = policy.escalateAfterSeconds === null
    ? null
    : integer(policy.escalateAfterSeconds, 900, 2592000);
  const smsFallback = bool(policy.smsFallback);
  if (!enabled) {
    if (
      deadlineAt !== null || intervalSeconds !== null || maximumReminders !== 0 ||
      escalateAfterSeconds !== null || smsFallback
    ) throw new ApiError(400, 'bad_request');
  } else {
    const publishAt = scheduledAt === null ? Date.now() : Date.parse(scheduledAt);
    if (
      deadlineAt === null || Date.parse(deadlineAt) <= publishAt || intervalSeconds === null ||
      maximumReminders < 1 ||
      (escalateAfterSeconds !== null && escalateAfterSeconds < intervalSeconds) || smsFallback
    ) throw new ApiError(400, 'bad_request');
  }
  return {
    enabled,
    deadline_at: deadlineAt,
    interval_seconds: intervalSeconds,
    maximum_reminders: maximumReminders,
    escalate_after_seconds: escalateAfterSeconds,
    // The free-plan build deliberately exposes that SMS fallback is disabled;
    // accepting true here would promise a delivery channel that is not configured.
    sms_fallback: false,
  };
}

function acknowledgementAttestation(value: unknown): JsonObject {
  if (value === null || value === undefined) return {};
  const input = asObject(value);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 8192) {
    throw new ApiError(400, 'bad_request');
  }
  const entries = Object.entries(input);
  if (entries.length > 20) throw new ApiError(400, 'bad_request');
  const attestation: JsonObject = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || entry === null) {
      throw new ApiError(400, 'bad_request');
    }
    if (typeof entry === 'string') {
      attestation[key] = normalizedString(entry, { min: 1, max: 1000 });
    } else if (typeof entry === 'boolean') {
      attestation[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      attestation[key] = entry;
    } else {
      throw new ApiError(400, 'bad_request');
    }
  }
  return attestation;
}

function moderationEvidenceMetadata(value: unknown): JsonObject {
  const input = asObject(value);
  onlyKeys(input, ['referenceIds', 'policyCode', 'severity']);
  const result: JsonObject = {};
  if ('referenceIds' in input) {
    const referenceIds = boundedTextArray(input.referenceIds, 20, 120);
    if (new Set(referenceIds).size !== referenceIds.length) {
      throw new ApiError(400, 'bad_request');
    }
    result.reference_ids = referenceIds;
  }
  if ('policyCode' in input) {
    const policyCode = requiredString(input, 'policyCode', { min: 2, max: 80 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(policyCode)) {
      throw new ApiError(400, 'bad_request');
    }
    result.policy_code = policyCode;
  }
  if ('severity' in input) {
    result.severity = oneOf(input.severity, ['low', 'medium', 'high', 'critical'] as const);
  }
  return result;
}

function groupMemberAssignments(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 499) {
    throw new ApiError(400, 'bad_request');
  }
  const assignments = value.map((entry) => {
    const row = asObject(entry);
    onlyKeys(row, ['membershipId', 'role']);
    return {
      user_id: requiredUuid(row, 'membershipId'),
      role: oneOf(row.role, ['owner', 'admin', 'member'] as const),
    };
  });
  if (new Set(assignments.map((entry) => entry.user_id)).size !== assignments.length) {
    throw new ApiError(400, 'bad_request');
  }
  return assignments;
}

export function parseCommand(route: MatchedRoute, input: unknown): ParsedCommand {
  const body = asObject(input);
  switch (route.kind) {
    case 'conversation.direct': {
      onlyKeys(body, ['organizationId', 'targetMembershipId']);
      return {
        organizationId: organization(body),
        values: { targetUserId: requiredUuid(body, 'targetMembershipId') },
      };
    }
    case 'conversation.group': {
      onlyKeys(body, [
        'organizationId',
        'name',
        'description',
        'memberAssignments',
        'kind',
        'unitId',
        'historyPolicy',
        'postingMode',
        'joinPolicy',
        'incidentSeverity',
        'incidentClassification',
      ]);
      const kind = optionalOneOf(
        body,
        'kind',
        ['group', 'team', 'shift', 'incident'] as const,
      ) ?? 'group';
      const joinPolicy = optionalOneOf(
        body,
        'joinPolicy',
        ['inherit', 'invite_only', 'approval_required'] as const,
      ) ?? (kind === 'shift' || kind === 'incident' ? 'invite_only' : 'inherit');
      const incidentSeverity = body.incidentSeverity === null || body.incidentSeverity === undefined
        ? null
        : oneOf(body.incidentSeverity, ['low', 'medium', 'high', 'critical'] as const);
      const incidentClassification = optionalString(body, 'incidentClassification', {
        min: 1,
        max: 120,
        nullable: true,
      }) ?? null;
      const incidentPolicyValid = kind === 'incident'
        ? incidentSeverity !== null && incidentClassification !== null
        : incidentSeverity === null && incidentClassification === null;
      if (
        !incidentPolicyValid ||
        ((kind === 'shift' || kind === 'incident') && joinPolicy !== 'invite_only')
      ) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          name: requiredString(body, 'name', { min: 1, max: 160 }),
          description: optionalString(body, 'description', {
            min: 1,
            max: 2000,
            nullable: true,
          }) ?? null,
          memberAssignments: groupMemberAssignments(body.memberAssignments),
          kind,
          unitId: optionalUuid(body, 'unitId', true) ?? null,
          historyPolicy: optionalOneOf(body, 'historyPolicy', ['all', 'since_join'] as const) ??
            'since_join',
          postingMode: optionalOneOf(
            body,
            'postingMode',
            ['all_members', 'admins_only'] as const,
          ) ?? 'all_members',
          joinPolicy,
          incidentSeverity,
          incidentClassification,
        },
      };
    }
    case 'conversation.group.candidates': {
      onlyKeys(body, ['organizationId', 'query', 'limit']);
      return {
        organizationId: organization(body),
        values: {
          query: optionalString(body, 'query', { max: 120, nullable: true }) ?? '',
          limit: optionalInteger(body, 'limit', 1, 100) ?? 50,
        },
      };
    }
    case 'conversation.member.candidates': {
      onlyKeys(body, ['organizationId', 'query', 'cursor', 'limit']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          query: optionalString(body, 'query', { max: 120, nullable: true }) ?? '',
          cursor: optionalString(body, 'cursor', {
            min: 1,
            max: 4096,
            trim: false,
            nullable: true,
          }) ?? null,
          limit: optionalInteger(body, 'limit', 1, 100) ?? 50,
        },
      };
    }
    case 'conversation.update': {
      onlyKeys(body, ['organizationId', 'name', 'description', 'isArchived']);
      const patch: JsonObject = {};
      if ('name' in body) {
        patch.name = optionalString(body, 'name', { min: 1, max: 160, nullable: true });
      }
      if ('description' in body) {
        patch.description = optionalString(body, 'description', { max: 2000, nullable: true });
      }
      if ('isArchived' in body) patch.is_archived = optionalBool(body, 'isArchived');
      if (Object.keys(patch).length === 0) throw new ApiError(400, 'bad_request');
      const values: JsonObject = {
        conversationId: pathUuid(route, 'conversationId'),
        patch,
      };
      return { organizationId: organization(body), values };
    }
    case 'conversation.preferences.update': {
      onlyKeys(body, [
        'organizationId',
        'isFavorite',
        'isPinned',
        'isArchived',
        'isHidden',
        'manuallyUnread',
        'notificationLevel',
        'mutedUntil',
        'translationMode',
      ]);
      const patch: JsonObject = {};
      if ('isFavorite' in body) patch.is_favorite = bool(body.isFavorite);
      if ('isPinned' in body) patch.is_pinned = bool(body.isPinned);
      // Archiving moves a chat somewhere quieter; hiding is "I deleted this
      // one for myself". Until v3.4 both wrote is_hidden, so archiving a chat
      // took it out of the snapshot and there was no archive to open.
      if ('isArchived' in body) patch.is_archived = bool(body.isArchived);
      if ('isHidden' in body) patch.is_hidden = bool(body.isHidden);
      // Marking a chat unread is a preference like the rest, so it survives a
      // relaunch and reaches the reader's other devices. Reading the chat
      // takes it back, which the receipt does server-side.
      if ('manuallyUnread' in body) patch.manually_unread = bool(body.manuallyUnread);
      if ('notificationLevel' in body) {
        patch.notification_level = oneOf(
          body.notificationLevel,
          ['all', 'mentions', 'none'] as const,
        );
      }
      if ('mutedUntil' in body) patch.muted_until = nullableIsoDate(body, 'mutedUntil');
      if ('translationMode' in body) {
        patch.translation_mode = oneOf(body.translationMode, ['automatic', 'off'] as const);
      }
      if (Object.keys(patch).length === 0) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: { conversationId: pathUuid(route, 'conversationId'), patch },
      };
    }
    case 'organization.preferences.update': {
      onlyKeys(body, [
        'organizationId',
        'uiLanguage',
        'messageLanguage',
        'timeZone',
        'quietHoursStart',
        'quietHoursEnd',
        'quietDays',
        'notificationPreview',
        'soundEnabled',
        'vibrationEnabled',
        'shiftAwareSuppression',
        'readVisibility',
      ]);
      const patch: JsonObject = {};
      if ('uiLanguage' in body) patch.ui_language = language(body.uiLanguage);
      if ('messageLanguage' in body) {
        patch.message_language = body.messageLanguage === null
          ? null
          : language(body.messageLanguage);
      }
      if ('timeZone' in body) {
        patch.time_zone = requiredString(body, 'timeZone', { min: 1, max: 100 });
      }
      const hasQuietStart = 'quietHoursStart' in body;
      const hasQuietEnd = 'quietHoursEnd' in body;
      if (hasQuietStart !== hasQuietEnd) throw new ApiError(400, 'bad_request');
      if (hasQuietStart) {
        const start = quietTime(body.quietHoursStart);
        const end = quietTime(body.quietHoursEnd);
        if ((start === null) !== (end === null)) throw new ApiError(400, 'bad_request');
        patch.quiet_hours_start = start;
        patch.quiet_hours_end = end;
      }
      if ('quietDays' in body) {
        if (
          !Array.isArray(body.quietDays) || body.quietDays.length < 1 || body.quietDays.length > 7
        ) {
          throw new ApiError(400, 'bad_request');
        }
        const days = body.quietDays.map((day) => integer(day, 0, 6));
        if (new Set(days).size !== days.length) throw new ApiError(400, 'bad_request');
        patch.quiet_days = days.sort((left, right) => left - right);
      }
      if ('notificationPreview' in body) {
        patch.notification_preview = oneOf(
          body.notificationPreview,
          ['generic', 'hidden'] as const,
        );
      }
      if ('soundEnabled' in body) patch.sound_enabled = bool(body.soundEnabled);
      if ('vibrationEnabled' in body) patch.vibration_enabled = bool(body.vibrationEnabled);
      if ('shiftAwareSuppression' in body) {
        patch.shift_aware_suppression = bool(body.shiftAwareSuppression);
      }
      if ('readVisibility' in body) {
        patch.read_visibility = oneOf(
          body.readVisibility,
          ['everyone', 'contacts', 'nobody'] as const,
        );
      }
      if (Object.keys(patch).length === 0) throw new ApiError(400, 'bad_request');
      return { organizationId: organization(body), values: { patch } };
    }
    case 'conversation.controls.update': {
      onlyKeys(body, ['organizationId', 'postingMode', 'joinPolicy', 'visibility', 'reason']);
      const values: JsonObject = {
        conversationId: pathUuid(route, 'conversationId'),
        postingMode: optionalOneOf(
          body,
          'postingMode',
          ['all_members', 'admins_only'] as const,
        ) ?? null,
        joinPolicy: optionalOneOf(
          body,
          'joinPolicy',
          ['inherit', 'invite_only', 'approval_required'] as const,
        ) ?? null,
        visibility: optionalOneOf(
          body,
          'visibility',
          ['invite_only', 'organization', 'unit'] as const,
        ) ?? null,
        reason: requiredString(body, 'reason', { min: 3, max: 500 }),
      };
      if (
        values.postingMode === null && values.joinPolicy === null && values.visibility === null
      ) throw new ApiError(400, 'bad_request');
      return { organizationId: organization(body), values };
    }
    case 'conversation.member.add': {
      onlyKeys(body, ['organizationId', 'membershipId', 'role']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          targetUserId: requiredUuid(body, 'membershipId'),
          role: optionalOneOf(body, 'role', ['member', 'admin'] as const) ?? 'member',
        },
      };
    }
    case 'conversation.member.remove': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          targetUserId: pathUuid(route, 'membershipId'),
        },
      };
    }
    case 'conversation.member.role.update': {
      onlyKeys(body, ['organizationId', 'expectedRole', 'newRole']);
      const expectedRole = oneOf(body.expectedRole, ['owner', 'admin', 'member'] as const);
      const newRole = oneOf(body.newRole, ['owner', 'admin', 'member'] as const);
      if (expectedRole === newRole) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          targetUserId: pathUuid(route, 'membershipId'),
          expectedRole,
          newRole,
        },
      };
    }
    case 'profile.avatar.grant': {
      onlyKeys(body, ['organizationId', 'fileName', 'mimeType', 'byteSize', 'sha256Hex']);
      const fileName = requiredString(body, 'fileName', { min: 1, max: 255, trim: false });
      const mimeType = requiredString(body, 'mimeType', { min: 3, max: 160 }).toLowerCase();
      const sha256 = requiredString(body, 'sha256Hex', { min: 64, max: 64 });
      if (
        fileName.includes('/') || fileName.includes('\\') ||
        !CONVERSATION_AVATAR_MIME_TYPES.has(mimeType) ||
        !SHA256_PATTERN.test(sha256)
      ) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          fileName,
          mimeType,
          byteSize: integer(body.byteSize, 1, PROFILE_AVATAR_MAX_BYTES),
          sha256Hex: sha256,
        },
      };
    }
    case 'profile.avatar.query': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { userId: pathUuid(route, 'userId') },
      };
    }
    case 'profile.avatar.activate': {
      onlyKeys(body, ['organizationId', 'expectedAvatarPath']);
      const organizationId = organization(body);
      const expectedAvatarPath = optionalString(body, 'expectedAvatarPath', {
        min: 1,
        max: 1024,
        trim: false,
        nullable: true,
      }) ?? null;
      if (expectedAvatarPath !== null) {
        try {
          const parts = expectedAvatarPath.split('/');
          validateProfileAvatarStoragePath(expectedAvatarPath, organizationId, uuid(parts[1]), uuid(parts[2]));
        } catch {
          throw new ApiError(400, 'bad_request');
        }
      }
      return {
        organizationId,
        values: { uploadId: pathUuid(route, 'uploadId'), expectedAvatarPath },
      };
    }
    case 'profile.avatar.remove': {
      onlyKeys(body, ['organizationId', 'expectedAvatarPath']);
      const organizationId = organization(body);
      const expectedAvatarPath = requiredString(body, 'expectedAvatarPath', { min: 1, max: 1024, trim: false });
      try {
        const parts = expectedAvatarPath.split('/');
        validateProfileAvatarStoragePath(expectedAvatarPath, organizationId, uuid(parts[1]), uuid(parts[2]));
      } catch {
        throw new ApiError(400, 'bad_request');
      }
      return { organizationId, values: { expectedAvatarPath } };
    }
    case 'conversation.avatar.grant': {
      onlyKeys(body, ['organizationId', 'fileName', 'mimeType', 'byteSize', 'sha256Hex']);
      const fileName = requiredString(body, 'fileName', { min: 1, max: 255, trim: false });
      const mimeType = requiredString(body, 'mimeType', { min: 3, max: 160 }).toLowerCase();
      const sha256 = requiredString(body, 'sha256Hex', { min: 64, max: 64 });
      if (
        fileName.includes('/') || fileName.includes('\\') ||
        !CONVERSATION_AVATAR_MIME_TYPES.has(mimeType) ||
        !SHA256_PATTERN.test(sha256)
      ) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          fileName,
          mimeType,
          byteSize: integer(body.byteSize, 1, CONVERSATION_AVATAR_MAX_BYTES),
          sha256Hex: sha256,
        },
      };
    }
    case 'conversation.avatar.query': {
      onlyKeys(body, ['organizationId', 'attachmentId']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          attachmentId: requiredUuid(body, 'attachmentId'),
        },
      };
    }
    case 'conversation.avatar.activate': {
      onlyKeys(body, ['organizationId', 'expectedAvatarPath']);
      const organizationId = organization(body);
      const conversationId = pathUuid(route, 'conversationId');
      const expectedAvatarPath = optionalString(body, 'expectedAvatarPath', {
        min: 1,
        max: 1024,
        trim: false,
        nullable: true,
      }) ?? null;
      if (expectedAvatarPath !== null) {
        try {
          const parts = expectedAvatarPath.split('/');
          validateConversationAvatarStoragePath(
            expectedAvatarPath,
            organizationId,
            conversationId,
            uuid(parts[3]),
          );
        } catch {
          throw new ApiError(400, 'bad_request');
        }
      }
      return {
        organizationId,
        values: {
          conversationId,
          attachmentId: pathUuid(route, 'attachmentId'),
          expectedAvatarPath,
        },
      };
    }
    case 'conversation.avatar.remove': {
      onlyKeys(body, ['organizationId', 'expectedAvatarPath']);
      const organizationId = organization(body);
      const conversationId = pathUuid(route, 'conversationId');
      const expectedAvatarPath = requiredString(body, 'expectedAvatarPath', {
        min: 1,
        max: 1024,
        trim: false,
      });
      try {
        const parts = expectedAvatarPath.split('/');
        validateConversationAvatarStoragePath(
          expectedAvatarPath,
          organizationId,
          conversationId,
          uuid(parts[3]),
        );
      } catch {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId,
        values: {
          conversationId,
          expectedAvatarPath,
        },
      };
    }
    case 'conversation.leave': {
      onlyKeys(body, [
        'organizationId',
        'replacementOwnerMembershipId',
        'confirmHistoryAndAccessLoss',
      ]);
      if (bool(body.confirmHistoryAndAccessLoss) !== true) {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          replacementOwnerUserId: optionalUuid(body, 'replacementOwnerMembershipId', true) ?? null,
        },
      };
    }
    case 'message.send': {
      onlyKeys(body, [
        'organizationId',
        'clientMessageId',
        'kind',
        'body',
        'languageCode',
        'replyToMessageId',
        'threadRootMessageId',
        'mentionUserIds',
      ]);
      const kind = optionalOneOf(body, 'kind', ['text', 'attachment'] as const) ?? 'text';
      const text = optionalString(body, 'body', { max: 20000, trim: false, nullable: true }) ??
        null;
      if (kind === 'text' && (!text || text.trim().length === 0)) {
        throw new ApiError(400, 'bad_request');
      }
      const mentionUserIds = optionalUuidArray(body, 'mentionUserIds', 50) ?? [];
      if (new Set(mentionUserIds).size !== mentionUserIds.length) {
        throw new ApiError(400, 'bad_request');
      }
      const metadata: JsonObject = mentionUserIds.length > 0 ? { mentionUserIds } : {};
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          clientNonce: requiredUuid(body, 'clientMessageId'),
          kind,
          body: text,
          languageCode: 'languageCode' in body && body.languageCode !== null
            ? language(body.languageCode)
            : null,
          replyToMessageId: optionalMessageId(body, 'replyToMessageId'),
          threadRootMessageId: optionalMessageId(body, 'threadRootMessageId'),
          metadata,
        },
      };
    }
    case 'message.edit': {
      onlyKeys(body, ['organizationId', 'conversationId', 'body', 'delete']);
      const remove = 'delete' in body ? bool(body.delete) : false;
      const text = optionalString(body, 'body', { min: 1, max: 20000, trim: false });
      if ((remove && text !== undefined) || (!remove && text === undefined)) {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          body: text ?? null,
          delete: remove,
        },
      };
    }
    case 'message.react': {
      onlyKeys(body, ['organizationId', 'conversationId', 'emoji', 'active']);
      // The "+" in the app hands over the phone's emoji keyboard, so anything
      // can arrive here. Store any emoji; store nothing else.
      const emoji = requiredString(body, 'emoji', { min: 1, max: 32, trim: false });
      if (!isSingleEmoji(emoji)) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          emoji,
          active: 'active' in body ? bool(body.active) : true,
        },
      };
    }
    case 'message.report': {
      onlyKeys(body, [
        'organizationId',
        'conversationId',
        'category',
        'details',
        'consentToShare',
        'contextBefore',
        'contextAfter',
        'noticeVersion',
      ]);
      if (
        bool(body.consentToShare) !== true ||
        !['moderation-share-v1', 'moderation-report-v2'].includes(String(body.noticeVersion))
      ) {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          category: oneOf(
            body.category,
            ['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const,
          ),
          details: optionalString(body, 'details', { max: 2000, nullable: true }) ?? null,
          consentToShare: true,
          contextBefore: integer(body.contextBefore, 0, 2),
          contextAfter: integer(body.contextAfter, 0, 2),
          noticeVersion: oneOf(
            body.noticeVersion,
            ['moderation-share-v1', 'moderation-report-v2'] as const,
          ),
        },
      };
    }
    case 'conversation.report': {
      onlyKeys(body, [
        'organizationId',
        'category',
        'details',
        'consentToShare',
        'noticeVersion',
      ]);
      if (bool(body.consentToShare) !== true || body.noticeVersion !== 'moderation-report-v2') {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          category: oneOf(
            body.category,
            ['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const,
          ),
          details: optionalString(body, 'details', { max: 2000, nullable: true }) ?? null,
          consentToShare: true,
          noticeVersion: 'moderation-report-v2',
        },
      };
    }
    case 'member.report': {
      onlyKeys(body, [
        'organizationId',
        'category',
        'details',
        'consentToShare',
        'noticeVersion',
      ]);
      if (bool(body.consentToShare) !== true || body.noticeVersion !== 'moderation-report-v2') {
        throw new ApiError(400, 'bad_request');
      }
      return {
        organizationId: organization(body),
        values: {
          subjectUserId: pathUuid(route, 'membershipId'),
          category: oneOf(
            body.category,
            ['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const,
          ),
          details: optionalString(body, 'details', { max: 2000, nullable: true }) ?? null,
          consentToShare: true,
          noticeVersion: 'moderation-report-v2',
        },
      };
    }
    case 'message.translate': {
      onlyKeys(body, ['organizationId', 'conversationId', 'targetLanguage']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          targetLanguage: language(body.targetLanguage),
        },
      };
    }
    case 'message.pin': {
      onlyKeys(body, ['organizationId', 'conversationId', 'pinned']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          pinned: bool(body.pinned),
        },
      };
    }
    case 'message.receipt': {
      onlyKeys(body, ['organizationId', 'conversationId', 'state']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          state: oneOf(body.state, ['delivered', 'read'] as const),
        },
      };
    }
    case 'message.link_preview': {
      onlyKeys(body, ['organizationId', 'url']);
      return {
        organizationId: organization(body),
        // Only https, only a public host, no credentials, no fragment: the
        // address came from a member and is treated accordingly.
        values: { url: normalizePreviewUrl(body.url) },
      };
    }
    case 'message.hide_for_me': {
      onlyKeys(body, ['organizationId', 'conversationId']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
        },
      };
    }
    case 'message.forward': {
      onlyKeys(body, [
        'organizationId',
        'sourceConversationId',
        'targetConversationId',
        'clientMessageId',
      ]);
      return {
        organizationId: organization(body),
        values: {
          sourceConversationId: requiredUuid(body, 'sourceConversationId'),
          sourceMessageId: pathMessageId(route),
          targetConversationId: requiredUuid(body, 'targetConversationId'),
          clientNonce: requiredUuid(body, 'clientMessageId'),
        },
      };
    }
    case 'translation.correction.propose': {
      onlyKeys(body, ['organizationId', 'conversationId', 'correctedBody', 'rationale']);
      return {
        organizationId: organization(body),
        values: {
          conversationId: requiredUuid(body, 'conversationId'),
          messageId: pathMessageId(route),
          targetLanguage: language(route.params.targetLanguage),
          correctedBody: requiredString(body, 'correctedBody', {
            min: 1,
            max: 20000,
            trim: false,
          }),
          rationale: optionalString(body, 'rationale', { max: 4000, nullable: true }) ?? null,
        },
      };
    }
    case 'translation.correction.review': {
      onlyKeys(body, ['organizationId', 'decision', 'note']);
      return {
        organizationId: organization(body),
        values: {
          correctionId: pathUuid(route, 'correctionId'),
          decision: oneOf(body.decision, ['approved', 'rejected', 'changes_requested'] as const),
          note: optionalString(body, 'note', { max: 4000, nullable: true }) ?? null,
        },
      };
    }
    case 'summary.request': {
      onlyKeys(body, ['organizationId', 'sourceMessageIds', 'languageCode', 'range']);
      const conversationId = pathUuid(route, 'conversationId');
      const languageCode = language(body.languageCode);
      // v3.1 clients name a range the server resolves; older clients still
      // send the message ids they had loaded.
      if (body.range !== undefined) {
        if (body.sourceMessageIds !== undefined) throw new ApiError(400, 'bad_request');
        const range = asObject(body.range);
        onlyKeys(range, ['kind', 'subject', 'fromMessageId', 'utcOffsetMinutes']);
        return {
          organizationId: organization(body),
          values: {
            conversationId,
            languageCode,
            range: {
              kind: oneOf(range.kind, SUMMARY_RANGE_KINDS),
              subject: optionalString(range, 'subject', { max: 200, nullable: true }) ?? null,
              fromMessageId: range.fromMessageId === undefined || range.fromMessageId === null
                ? null
                : messageId(range.fromMessageId),
              utcOffsetMinutes: range.utcOffsetMinutes === undefined
                ? 0
                : integer(range.utcOffsetMinutes, -900, 900),
            },
          },
        };
      }
      const sourceMessageIds = messageIdArray(body.sourceMessageIds);
      if (!sourceMessageIds.length) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: { conversationId, sourceMessageIds, languageCode },
      };
    }
    case 'summary.manual.create': {
      onlyKeys(body, [
        'organizationId',
        'sourceMessageIds',
        'languageCode',
        'primaryTopic',
        'summary',
        'keyTopics',
        'decisions',
        'actionItems',
        'ambiguities',
      ]);
      const sourceMessageIds = messageIdArray(body.sourceMessageIds);
      if (!sourceMessageIds.length) throw new ApiError(400, 'bad_request');
      const sourceSet = new Set(sourceMessageIds);
      return {
        organizationId: organization(body),
        values: {
          conversationId: pathUuid(route, 'conversationId'),
          sourceMessageIds,
          languageCode: language(body.languageCode),
          primaryTopic: requiredString(body, 'primaryTopic', { min: 1, max: 240 }),
          summary: requiredString(body, 'summary', { min: 1, max: 30000 }),
          keyTopics: boundedTextArray(body.keyTopics, 50, 500),
          decisions: summaryEvidenceArray(body.decisions, sourceSet, 'decision'),
          actionItems: summaryEvidenceArray(body.actionItems, sourceSet, 'action'),
          ambiguities: boundedTextArray(body.ambiguities, 50, 2000),
        },
      };
    }
    case 'ai_output.error.report': {
      onlyKeys(body, [
        'organizationId',
        'outputKind',
        'translationId',
        'summaryId',
        'category',
        'details',
        'highConsequence',
        'qualityUseConsent',
        'consentVersion',
      ]);
      const outputKind = oneOf(body.outputKind, ['translation', 'summary'] as const);
      const translationId = optionalMessageId(body, 'translationId');
      const summaryId = optionalUuid(body, 'summaryId', true) ?? null;
      if (
        (outputKind === 'translation' && (translationId === null || summaryId !== null)) ||
        (outputKind === 'summary' && (summaryId === null || translationId !== null))
      ) throw new ApiError(400, 'bad_request');
      const category = outputKind === 'translation'
        ? oneOf(
          body.category,
          [
            'incorrect_meaning',
            'omitted_context',
            'terminology',
            'unsafe_wording',
            'wrong_language',
            'other',
          ] as const,
        )
        : oneOf(
          body.category,
          [
            'unsupported_claim',
            'missing_source',
            'incorrect_action',
            'omitted_context',
            'unsafe_wording',
            'other',
          ] as const,
        );
      return {
        organizationId: organization(body),
        values: {
          outputKind,
          translationId,
          summaryId,
          category,
          details: requiredString(body, 'details', { min: 3, max: 4000 }),
          highConsequence: bool(body.highConsequence),
          qualityUseConsent: bool(body.qualityUseConsent),
          consentVersion: requiredString(body, 'consentVersion', { min: 3, max: 80 }),
        },
      };
    }
    case 'ai_output.error_reports.self.query': {
      onlyKeys(body, ['organizationId', 'limit']);
      return {
        organizationId: organization(body),
        values: { limit: optionalInteger(body, 'limit', 1, 100) ?? 50 },
      };
    }
    case 'contact.request': {
      onlyKeys(body, ['organizationId', 'targetMembershipId']);
      return {
        organizationId: organization(body),
        values: { targetUserId: requiredUuid(body, 'targetMembershipId') },
      };
    }
    case 'contact.message_request': {
      onlyKeys(body, ['organizationId', 'targetUserId', 'body']);
      // Same body envelope as message.send: the first hello travels the same
      // trusted message path once the database opens the pending window.
      const text = requiredString(body, 'body', { min: 1, max: 20000, trim: false });
      if (text.trim().length === 0) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          targetUserId: requiredUuid(body, 'targetUserId'),
          body: text,
        },
      };
    }
    case 'contact.respond': {
      onlyKeys(body, ['organizationId', 'decision']);
      return {
        organizationId: organization(body),
        values: {
          targetUserId: pathUuid(route, 'membershipId'),
          decision: oneOf(body.decision, ['accepted', 'declined'] as const),
        },
      };
    }
    case 'contact.cancel': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { targetUserId: pathUuid(route, 'membershipId') },
      };
    }
    case 'profile.update': {
      // A consumer edits the two self-service profile columns together. An
      // absent, null, or blank status message clears the column; the
      // username is gateway-owned and is not accepted here at all.
      onlyKeys(body, ['organizationId', 'displayName', 'statusMessage']);
      const statusMessage = optionalString(body, 'statusMessage', { max: 280, nullable: true });
      return {
        organizationId: organization(body),
        values: {
          displayName: requiredString(body, 'displayName', { min: 1, max: 120 }),
          statusMessage: statusMessage ? statusMessage : null,
        },
      };
    }
    case 'saved_contact.update': {
      onlyKeys(body, ['organizationId', 'alias', 'isFavorite']);
      const patch: JsonObject = {};
      if ('alias' in body) {
        patch.alias = body.alias === null
          ? null
          : requiredString(body, 'alias', { min: 1, max: 120 });
      }
      if ('isFavorite' in body) patch.is_favorite = bool(body.isFavorite);
      if (Object.keys(patch).length === 0) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: { contactUserId: pathUuid(route, 'membershipId'), patch },
      };
    }
    case 'saved_contact.remove':
    case 'member.block':
    case 'member.unblock':
    case 'person.mute':
    case 'person.unmute': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { targetUserId: pathUuid(route, 'membershipId') },
      };
    }
    case 'handoff.sign': {
      onlyKeys(body, ['organizationId', 'deviceId']);
      return {
        organizationId: organization(body),
        values: {
          handoffVersionId: pathUuid(route, 'versionId'),
          deviceId: optionalUuid(body, 'deviceId', true) ?? null,
        },
      };
    }
    case 'handoff.acknowledge': {
      onlyKeys(body, ['organizationId', 'note', 'deviceId']);
      return {
        organizationId: organization(body),
        values: {
          handoffVersionId: pathUuid(route, 'versionId'),
          note: optionalString(body, 'note', { max: 2000, nullable: true }) ?? null,
          deviceId: optionalUuid(body, 'deviceId', true) ?? null,
        },
      };
    }
    case 'action.confirm': {
      onlyKeys(body, ['organizationId', 'assigneeMembershipId', 'dueAt']);
      return {
        organizationId: organization(body),
        values: {
          actionId: pathUuid(route, 'actionId'),
          assigneeUserId: requiredUuid(body, 'assigneeMembershipId'),
          dueAt: nullableIsoDate(body, 'dueAt'),
        },
      };
    }
    case 'attachment.grant': {
      onlyKeys(body, [
        'organizationId',
        'action',
        'conversationId',
        'messageId',
        'attachmentId',
        'fileName',
        'mimeType',
        'byteSize',
        'sha256Hex',
      ]);
      const action = oneOf(body.action, ['upload', 'download'] as const);
      const base: JsonObject = {
        action,
        conversationId: requiredUuid(body, 'conversationId'),
      };
      if (action === 'upload') {
        if ('attachmentId' in body) throw new ApiError(400, 'bad_request');
        const fileName = requiredString(body, 'fileName', { min: 1, max: 255, trim: false });
        if (fileName.includes('/') || fileName.includes('\\')) {
          throw new ApiError(400, 'bad_request');
        }
        const mimeType = requiredString(body, 'mimeType', { min: 3, max: 160 }).toLowerCase();
        if (!SAFE_MIME_TYPES.has(mimeType)) throw new ApiError(400, 'bad_request');
        const sha256 = requiredString(body, 'sha256Hex', { min: 64, max: 64 });
        if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, 'bad_request');
        Object.assign(base, {
          messageId: messageId(body.messageId),
          fileName,
          mimeType,
          byteSize: integer(
            body.byteSize,
            1,
            VIDEO_MIME_TYPES.has(mimeType) ? VIDEO_ATTACHMENT_MAX_BYTES : ATTACHMENT_MAX_BYTES,
          ),
          sha256Hex: sha256,
        });
      } else {
        if (
          ['messageId', 'fileName', 'mimeType', 'byteSize', 'sha256Hex'].some((key) => key in body)
        ) throw new ApiError(400, 'bad_request');
        Object.assign(base, { attachmentId: requiredUuid(body, 'attachmentId') });
      }
      return { organizationId: organization(body), values: base };
    }
    case 'attachment.state': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { attachmentId: pathUuid(route, 'attachmentId') },
      };
    }
    case 'attachment.complete': {
      onlyKeys(body, ['organizationId', 'bucket', 'path', 'byteSize', 'sha256Hex']);
      const bucketId = requiredString(body, 'bucket', { min: 1, max: 100 });
      const storagePath = requiredString(body, 'path', { min: 1, max: 1024, trim: false });
      const sha256 = requiredString(body, 'sha256Hex', { min: 64, max: 64 });
      if (
        bucketId !== 'message-attachments' || storagePath.includes('..') ||
        storagePath.startsWith('/') || !SHA256_PATTERN.test(sha256)
      ) throw new ApiError(400, 'bad_request');
      return {
        organizationId: organization(body),
        values: {
          attachmentId: pathUuid(route, 'attachmentId'),
          bucketId,
          storagePath,
          // The MIME type is not part of the completion request; the finalize
          // RPC verifies the exact byte size against the granted row, which
          // already carries the per-type cap.
          byteSize: integer(body.byteSize, 1, VIDEO_ATTACHMENT_MAX_BYTES),
          sha256Hex: sha256,
        },
      };
    }
    case 'device.register': {
      try {
        onlyKeys(body, [
          'organizationId', 'installationId', 'platform', 'pushToken', 'pushTokenType',
          'pushProjectId', 'pushEnvironment', 'appVersion', 'locale',
        ]);
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          throw new ApiError(400, 'bad_request', `device.register: keys ${Object.keys(body).sort().join(',')}`);
        }
        throw error;
      }
      onlyKeys(body, [
        'organizationId',
        'installationId',
        'platform',
        'pushToken',
        'pushTokenType',
        'pushProjectId',
        'pushEnvironment',
        'appVersion',
        'locale',
      ]);
      // The locale is informational. Phones report tags with Unicode extensions
      // ("en-US-u-hc-h23" for a 24-hour clock, "-u-ca-…" for a calendar), and
      // refusing the whole registration for that left people unable to turn
      // notifications on ("check the entered information", Sep 6 2026). Keep
      // the language-script-region core; drop anything the pattern rejects.
      const rawLocale = optionalString(body, 'locale', { max: 80, nullable: true }) ?? null;
      const locale = rawLocale === null ? null : normalizeLocaleTag(rawLocale);
      // A refused registration names the field in the error message so the
      // rejection log says what the phone sent wrong (owner report, Sep 6 2026:
      // four 400s with no clue which value they were about).
      const field = <T>(name: string, parse: () => T): T => {
        try {
          return parse();
        } catch (error) {
          if (error instanceof ApiError && error.status === 400) {
            throw new ApiError(400, 'bad_request', `device.register: ${name}`);
          }
          throw error;
        }
      };
      return {
        organizationId: field('organizationId', () => organization(body)),
        values: {
          installationId: field('installationId', () => requiredUuid(body, 'installationId')),
          platform: field('platform', () => oneOf(body.platform, ['ios', 'android'] as const)),
          pushToken: field('pushToken', () => expoPushToken(body.pushToken)),
          pushTokenType: field('pushTokenType', () => oneOf(body.pushTokenType, ['expo'] as const)),
          pushProjectId: field('pushProjectId', () => requiredUuid(body, 'pushProjectId')),
          pushEnvironment: field('pushEnvironment', () => oneOf(
            body.pushEnvironment,
            ['development', 'preview', 'production'] as const,
          )),
          appVersion: field('appVersion', () => optionalString(body, 'appVersion', { max: 80, nullable: true }) ?? null),
          locale,
        },
      };
    }
    case 'device.preferences.read': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { installationId: pathUuid(route, 'installationId') },
      };
    }
    case 'device.preferences.update': {
      onlyKeys(body, ['organizationId', 'expectedVersion', 'patch']);
      const rawPatch = asObject(body.patch);
      onlyKeys(rawPatch, ['notificationPreview', 'soundEnabled', 'vibrationEnabled']);
      if (Object.keys(rawPatch).length === 0) throw new ApiError(400, 'bad_request');
      const patch: JsonObject = {};
      if ('notificationPreview' in rawPatch) {
        patch.notification_preview = rawPatch.notificationPreview === null
          ? null
          : oneOf(rawPatch.notificationPreview, ['generic', 'hidden'] as const);
      }
      if ('soundEnabled' in rawPatch) {
        patch.sound_enabled = rawPatch.soundEnabled === null ? null : bool(rawPatch.soundEnabled);
      }
      if ('vibrationEnabled' in rawPatch) {
        patch.vibration_enabled = rawPatch.vibrationEnabled === null
          ? null
          : bool(rawPatch.vibrationEnabled);
      }
      return {
        organizationId: organization(body),
        values: {
          installationId: pathUuid(route, 'installationId'),
          expectedVersion: integer(body.expectedVersion, 1, 2_147_483_647),
          patch,
        },
      };
    }
    case 'device.mute.read': {
      onlyKeys(body, ['organizationId']);
      return {
        organizationId: organization(body),
        values: { installationId: pathUuid(route, 'installationId') },
      };
    }
    case 'device.mute.update': {
      onlyKeys(body, ['organizationId', 'muted']);
      return {
        organizationId: organization(body),
        values: {
          installationId: pathUuid(route, 'installationId'),
          muted: bool(body.muted),
        },
      };
    }
    case 'session.list': {
      onlyKeys(body, ['organizationId']);
      return { organizationId: organization(body), values: {} };
    }
    case 'session.revoke.self': {
      onlyKeys(body, ['organizationId', 'reason']);
      return {
        organizationId: organization(body),
        values: {
          targetSessionId: pathUuid(route, 'sessionId'),
          reason: requiredString(body, 'reason', { min: 3, max: 500 }),
        },
      };
    }
  }
  throw new ApiError(500, 'internal_error');
}

function commonArgs(
  actor: AuthenticatedActor,
  organizationId: string,
  idempotencyKey: string,
  requestDigest: string,
): JsonObject {
  return {
    p_actor_user_id: actor.user.id,
    p_organization_id: organizationId,
    p_session_id: actor.claims.sessionId,
    p_idempotency_key: idempotencyKey,
    p_request_sha256: requestDigest,
  };
}

async function businessRpc(
  actor: AuthenticatedActor,
  organizationId: string,
  idempotencyKey: string,
  requestDigest: string,
  name: string,
  args: JsonObject,
): Promise<unknown> {
  return toPublicJson(
    await invokeRpc(
      asRpcClient(actor.adminClient),
      name,
      { ...commonArgs(actor, organizationId, idempotencyKey, requestDigest), ...args },
    ),
  );
}

function resolvedInviteUserId(value: unknown): string | null {
  const row = asObject(value);
  if (row.authorized !== true) throw new ApiError(403, 'forbidden');
  return row.user_id === null ? null : uuid(row.user_id);
}

function maskedInviteDestination(destinationType: 'email' | 'phone', destination: string): string {
  if (destinationType === 'phone') {
    return `${destination.slice(0, 2)}${'*'.repeat(Math.max(4, destination.length - 6))}${
      destination.slice(-4)
    }`;
  }
  const separator = destination.lastIndexOf('@');
  const local = destination.slice(0, separator);
  return `${local.slice(0, 1)}***${destination.slice(separator)}`;
}

async function resolveInvitePrincipal(
  actor: AuthenticatedActor,
  organizationId: string,
  destinationType: 'email' | 'phone',
  destination: string,
): Promise<string | null> {
  return resolvedInviteUserId(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_resolve_invite_principal', {
      p_actor_user_id: actor.user.id,
      p_organization_id: organizationId,
      p_session_id: actor.claims.sessionId,
      p_destination_type: destinationType,
      p_destination: destination,
    }),
  );
}

async function issueOrganizationInvite(
  actor: AuthenticatedActor,
  command: ParsedCommand,
  idempotencyKey: string,
  requestDigest: string,
): Promise<unknown> {
  const destinationType = command.values.destinationType as 'email' | 'phone';
  const destination = command.values.destination as string;
  let invitedUserId = await resolveInvitePrincipal(
    actor,
    command.organizationId,
    destinationType,
    destination,
  );
  let newlyCreated = false;
  if (!invitedUserId) {
    const principal = destinationType === 'email'
      ? { email: destination, email_confirm: true }
      : { phone: destination, phone_confirm: true };
    const { data, error } = await actor.adminClient.auth.admin.createUser({
      ...principal,
      app_metadata: { newone_invite_state: 'pending' },
    });
    if (!error && data.user) {
      invitedUserId = uuid(data.user.id);
      newlyCreated = true;
    } else {
      // A concurrent inviter may have created the same exact principal. Resolve
      // through the bounded database primitive; never paginate Auth users.
      invitedUserId = await resolveInvitePrincipal(
        actor,
        command.organizationId,
        destinationType,
        destination,
      );
    }
  }
  if (!invitedUserId) throw new ApiError(503, 'dependency_unavailable', undefined, 5);

  try {
    const result = await businessRpc(
      actor,
      command.organizationId,
      idempotencyKey,
      requestDigest,
      'bff_issue_organization_invite_v2',
      {
        p_destination_type: destinationType,
        p_destination: destination,
        p_invited_user_id: invitedUserId,
        p_employee_code: command.values.employeeCode,
        p_activation_mode: command.values.activationMode,
        p_role: command.values.role,
        p_expires_in_seconds: command.values.expiresInSeconds,
        p_membership_type: command.values.membershipType,
        p_membership_access_expires_at: command.values.membershipAccessExpiresAt,
        p_guest_sponsor_user_id: command.values.guestSponsorUserId,
      },
    );
    if (newlyCreated) {
      try {
        await actor.adminClient.auth.admin.updateUserById(invitedUserId, {
          app_metadata: { newone_invite_state: 'invited' },
        });
      } catch {
        // The database-bound invite is authoritative. Metadata is only a
        // cleanup hint and must not invalidate an otherwise successful invite.
      }
    }
    const row = asObject(result);
    const inviteId = uuid(row.inviteId);
    const expiresAt = normalizedString(row.expiresAt, { min: 20, max: 40 }) as string;
    if (!Number.isFinite(Date.parse(expiresAt)) || row.singleUse !== true) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    if (typeof row.tokenAvailable !== 'boolean') {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    const token = row.token;
    if (
      (row.tokenAvailable && (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))) ||
      (!row.tokenAvailable && token !== undefined && token !== null)
    ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    if (
      row.destinationType !== destinationType ||
      row.activationMode !== command.values.activationMode ||
      typeof row.channelConfigured !== 'boolean'
    ) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    const membershipAccessExpiresAt = row.membershipAccessExpiresAt === null
      ? null
      : isoDate(row.membershipAccessExpiresAt);
    const guestSponsorUserId = row.guestSponsorUserId === null
      ? null
      : uuid(row.guestSponsorUserId);
    const requestedMembershipExpiryMs = typeof command.values.membershipAccessExpiresAt === 'string'
      ? Date.parse(command.values.membershipAccessExpiresAt)
      : null;
    const returnedMembershipExpiryMs = membershipAccessExpiresAt === null
      ? null
      : Date.parse(membershipAccessExpiresAt);
    if (
      row.membershipType !== command.values.membershipType ||
      returnedMembershipExpiryMs !== requestedMembershipExpiryMs ||
      guestSponsorUserId !== command.values.guestSponsorUserId
    ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    return {
      inviteId,
      destinationType,
      destinationMasked: maskedInviteDestination(destinationType, destination),
      role: command.values.role,
      activationMode: command.values.activationMode,
      expiresAt,
      singleUse: true,
      ...(row.tokenAvailable ? { activationToken: token as string } : {}),
      tokenAvailable: row.tokenAvailable,
      channelConfigured: row.channelConfigured,
      membershipType: command.values.membershipType,
      membershipAccessExpiresAt,
      guestSponsorUserId,
      // A raw token is returned only on the first successful issue. Idempotent
      // replays intentionally return metadata without recovering the secret.
      delivery: 'manual_secure',
    };
  } catch (error) {
    if (newlyCreated) {
      try {
        await actor.adminClient.auth.admin.updateUserById(invitedUserId, {
          app_metadata: { newone_invite_state: 'orphaned' },
          ban_duration: '876000h',
        });
      } catch {
        // Even if compensation is unavailable, no active membership exists and
        // every Newone data path independently rejects the orphaned principal.
      }
    }
    throw error;
  }
}

export function configuredPublicAppUrl(
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): string {
  const raw = env.get('NEWONE_PUBLIC_APP_URL')?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('NEWONE_PUBLIC_APP_URL must be a canonical HTTPS origin');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '' && url.pathname !== '/') || url.origin !== raw.replace(/\/$/, '')
  ) throw new Error('NEWONE_PUBLIC_APP_URL must be a canonical HTTPS origin');
  return url.origin;
}

function toPublicJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPublicJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      toPublicJson(entry),
    ]),
  );
}

function exactDependencyKeys(row: JsonObject, keys: readonly string[]): void {
  onlyKeys(row, keys);
  if (Object.keys(row).length !== keys.length) throw new Error('incomplete dependency response');
}

function publicOrganizationAiPolicy(
  value: unknown,
  expectedOrganizationId: string,
  expectedUpdate?: {
    enabled: boolean;
    approvedUseCases: string[];
    providerAllowlist: string[];
    routePolicy: string;
    expectedVersion: number;
  },
): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, [
      'organizationId',
      'enabled',
      'policyVersion',
      'approvedUseCases',
      'providerAllowlist',
      'routePolicy',
      'tenantApproved',
      'globalKillSwitchStillRequired',
    ]);
    const organizationId = uuid(row.organizationId);
    const enabled = bool(row.enabled);
    const policyVersion = integer(row.policyVersion, 0, 2_147_483_647);
    const approvedUseCases = aiUseCaseArray(row.approvedUseCases);
    const providerAllowlist = aiProviderArray(row.providerAllowlist);
    const routePolicy = oneOf(row.routePolicy, ['deny', 'approved_zero_retention'] as const);
    const tenantApproved = bool(row.tenantApproved);
    if (
      organizationId !== expectedOrganizationId ||
      row.globalKillSwitchStillRequired !== true ||
      tenantApproved !== enabled ||
      (enabled && (
        policyVersion < 1 || approvedUseCases.length < 1 || providerAllowlist.length < 1 ||
        routePolicy !== 'approved_zero_retention'
      )) ||
      (!enabled && (
        approvedUseCases.length !== 0 || providerAllowlist.length !== 0 || routePolicy !== 'deny'
      )) ||
      (policyVersion === 0 && enabled)
    ) throw new Error('incoherent organization AI policy');
    if (
      expectedUpdate && (
        enabled !== expectedUpdate.enabled ||
        policyVersion !== expectedUpdate.expectedVersion + 1 ||
        routePolicy !== expectedUpdate.routePolicy ||
        JSON.stringify(approvedUseCases) !== JSON.stringify(expectedUpdate.approvedUseCases) ||
        JSON.stringify(providerAllowlist) !== JSON.stringify(expectedUpdate.providerAllowlist)
      )
    ) throw new Error('organization AI policy receipt mismatch');
    return {
      organizationId,
      enabled,
      policyVersion,
      approvedUseCases,
      providerAllowlist,
      routePolicy,
      tenantApproved,
      globalKillSwitchStillRequired: true,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function dynamicGroupFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error('invalid dynamic-group fingerprint');
  }
  return value;
}

function dynamicGroupNullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function dynamicGroupTimestamp(value: unknown): string {
  return isoDate(value);
}

function dynamicGroupNullableTimestamp(value: unknown): string | null {
  return value === null ? null : dynamicGroupTimestamp(value);
}

function canonicalDynamicGroupUuidArray(value: unknown, maximum: number): string[] {
  const result = uuidArray(value, maximum);
  if (result.some((entry, index) => index > 0 && result[index - 1]! >= entry)) {
    throw new Error('dynamic-group UUIDs are not canonical');
  }
  return result;
}

function canonicalDynamicGroupTextArray(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error('invalid dynamic-group text array');
  }
  const result = value.map((entry) => {
    const parsed = normalizedString(entry, { min: 1, max: 160 }) as string;
    if (parsed !== parsed.toLocaleLowerCase('en-US')) {
      throw new Error('dynamic-group text is not canonical');
    }
    return parsed;
  });
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && result[index - 1]! >= entry)
  ) throw new Error('dynamic-group text is not canonical');
  return result;
}

function publicDynamicGroupPolicySpec(value: unknown): JsonObject {
  const row = asObject(value);
  exactDependencyKeys(row, [
    'siteIds',
    'departmentIds',
    'teamIds',
    'lineIds',
    'unitIds',
    'includeDescendants',
    'operationalRoles',
    'membershipRoles',
    'shiftMode',
    'scheduledShiftStartsAt',
    'scheduledShiftEndsAt',
  ]);
  const accessRoles = canonicalDynamicGroupTextArray(row.membershipRoles, 4);
  if (
    accessRoles.length < 1 ||
    accessRoles.some((role) => !['owner', 'admin', 'manager', 'member'].includes(role))
  ) throw new Error('invalid dynamic-group membership role');
  const shiftMode = oneOf(row.shiftMode, ['none', 'current', 'scheduled'] as const);
  const scheduledShiftStartsAt = dynamicGroupNullableTimestamp(row.scheduledShiftStartsAt);
  const scheduledShiftEndsAt = dynamicGroupNullableTimestamp(row.scheduledShiftEndsAt);
  if (
    (shiftMode !== 'scheduled' &&
      (scheduledShiftStartsAt !== null || scheduledShiftEndsAt !== null)) ||
    (shiftMode === 'scheduled' &&
      (scheduledShiftStartsAt === null || scheduledShiftEndsAt === null ||
        Date.parse(scheduledShiftEndsAt) <= Date.parse(scheduledShiftStartsAt) ||
        Date.parse(scheduledShiftEndsAt) - Date.parse(scheduledShiftStartsAt) >
          31 * 24 * 60 * 60 * 1000))
  ) throw new Error('invalid dynamic-group shift window');
  return {
    siteIds: canonicalDynamicGroupUuidArray(row.siteIds, 100),
    departmentIds: canonicalDynamicGroupUuidArray(row.departmentIds, 100),
    teamIds: canonicalDynamicGroupUuidArray(row.teamIds, 100),
    lineIds: canonicalDynamicGroupUuidArray(row.lineIds, 100),
    unitIds: canonicalDynamicGroupUuidArray(row.unitIds, 100),
    includeDescendants: bool(row.includeDescendants),
    operationalRoles: canonicalDynamicGroupTextArray(row.operationalRoles, 50),
    membershipRoles: accessRoles,
    shiftMode,
    scheduledShiftStartsAt,
    scheduledShiftEndsAt,
  };
}

function publicDynamicGroupPolicy(value: unknown): JsonObject {
  const row = asObject(value);
  exactDependencyKeys(row, [
    'policyId',
    'conversationId',
    'conversationName',
    'conversationKind',
    'conversationUnitId',
    'status',
    'version',
    'draftState',
    'policySpec',
    'maximumMembers',
    'selectorFingerprint',
    'publishedVersionId',
    'lastPreviewFingerprint',
    'lastPreviewedAt',
    'lastSyncedAt',
    'nextEvaluationAt',
    'sourceChangedAt',
    'createdAt',
    'updatedAt',
  ]);
  const status = oneOf(row.status, ['draft', 'active', 'paused'] as const);
  const draftState = oneOf(row.draftState, ['draft', 'previewed', 'published'] as const);
  const publishedVersionId = dynamicGroupNullableUuid(row.publishedVersionId);
  const lastPreviewFingerprint = row.lastPreviewFingerprint === null
    ? null
    : dynamicGroupFingerprint(row.lastPreviewFingerprint);
  const lastPreviewedAt = dynamicGroupNullableTimestamp(row.lastPreviewedAt);
  if (
    (status === 'draft' && publishedVersionId !== null) ||
    (status !== 'draft' && publishedVersionId === null) ||
    (draftState === 'draft' &&
      (lastPreviewFingerprint !== null || lastPreviewedAt !== null)) ||
    (draftState !== 'draft' &&
      (lastPreviewFingerprint === null || lastPreviewedAt === null))
  ) throw new Error('invalid dynamic-group lifecycle');
  return {
    policyId: uuid(row.policyId),
    conversationId: uuid(row.conversationId),
    conversationName: normalizedString(row.conversationName, { min: 1, max: 160 }) as string,
    conversationKind: oneOf(row.conversationKind, ['group', 'team', 'shift'] as const),
    conversationUnitId: dynamicGroupNullableUuid(row.conversationUnitId),
    status,
    version: integer(row.version, 1, 2_147_483_647),
    draftState,
    policySpec: publicDynamicGroupPolicySpec(row.policySpec),
    maximumMembers: integer(row.maximumMembers, 1, 5000),
    selectorFingerprint: dynamicGroupFingerprint(row.selectorFingerprint),
    publishedVersionId,
    lastPreviewFingerprint,
    lastPreviewedAt,
    lastSyncedAt: dynamicGroupNullableTimestamp(row.lastSyncedAt),
    nextEvaluationAt: dynamicGroupNullableTimestamp(row.nextEvaluationAt),
    sourceChangedAt: dynamicGroupNullableTimestamp(row.sourceChangedAt),
    createdAt: dynamicGroupTimestamp(row.createdAt),
    updatedAt: dynamicGroupTimestamp(row.updatedAt),
  };
}

function publicDynamicGroupPolicyList(value: unknown, requestedLimit: number): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, ['policies', 'limit', 'nextAfterPolicyId']);
    const limit = integer(row.limit, 1, 100);
    if (limit !== requestedLimit || !Array.isArray(row.policies) || row.policies.length > limit) {
      throw new Error('invalid dynamic-group policy page');
    }
    const policies = row.policies.map(publicDynamicGroupPolicy);
    if (
      new Set(policies.map((policy) => policy.policyId)).size !== policies.length ||
      policies.some((policy, index) =>
        index > 0 && String(policies[index - 1]!.policyId) >= String(policy.policyId)
      )
    ) throw new Error('invalid dynamic-group policy order');
    const nextAfterPolicyId = dynamicGroupNullableUuid(row.nextAfterPolicyId);
    if (
      nextAfterPolicyId !== null &&
      (policies.length !== limit || policies.at(-1)?.policyId !== nextAfterPolicyId)
    ) throw new Error('invalid dynamic-group policy cursor');
    return { policies, limit, nextAfterPolicyId };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicDynamicGroupSaveReceipt(value: unknown): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, [
      'policyId',
      'conversationId',
      'version',
      'draftState',
      'selectorFingerprint',
      'requiresPreview',
      'publishedVersionId',
    ]);
    if (row.draftState !== 'draft' || row.requiresPreview !== true) {
      throw new Error('invalid dynamic-group save state');
    }
    return {
      policyId: uuid(row.policyId),
      conversationId: uuid(row.conversationId),
      version: integer(row.version, 1, 2_147_483_647),
      draftState: 'draft',
      selectorFingerprint: dynamicGroupFingerprint(row.selectorFingerprint),
      requiresPreview: true,
      publishedVersionId: dynamicGroupNullableUuid(row.publishedVersionId),
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function dynamicGroupSampleIds(value: unknown, count: number, maximum: number): string[] {
  const samples = canonicalDynamicGroupUuidArray(value, maximum);
  if (samples.length > count) throw new Error('invalid dynamic-group samples');
  return samples;
}

function publicDynamicGroupPreviewReceipt(value: unknown, sampleLimit: number): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, [
      'policyId',
      'policyVersion',
      'previewFingerprint',
      'selectorFingerprint',
      'membershipStateFingerprint',
      'evaluatedAt',
      'validUntil',
      'eligibleCount',
      'addedCount',
      'removedCount',
      'unchangedCount',
      'addedSampleUserIds',
      'removedSampleUserIds',
      'unchangedSampleUserIds',
      'nextBoundaryAt',
    ]);
    const eligibleCount = integer(row.eligibleCount, 0, 5000);
    const addedCount = integer(row.addedCount, 0, 5000);
    const removedCount = integer(row.removedCount, 0, 5000);
    const unchangedCount = integer(row.unchangedCount, 0, 5000);
    if (addedCount + unchangedCount !== eligibleCount) {
      throw new Error('invalid dynamic-group preview counts');
    }
    const addedSampleUserIds = dynamicGroupSampleIds(
      row.addedSampleUserIds,
      addedCount,
      sampleLimit,
    );
    const removedSampleUserIds = dynamicGroupSampleIds(
      row.removedSampleUserIds,
      removedCount,
      sampleLimit,
    );
    const unchangedSampleUserIds = dynamicGroupSampleIds(
      row.unchangedSampleUserIds,
      unchangedCount,
      sampleLimit,
    );
    const allSamples = [...addedSampleUserIds, ...removedSampleUserIds, ...unchangedSampleUserIds];
    if (new Set(allSamples).size !== allSamples.length) {
      throw new Error('overlapping dynamic-group samples');
    }
    const evaluatedAt = dynamicGroupTimestamp(row.evaluatedAt);
    const validUntil = dynamicGroupTimestamp(row.validUntil);
    const validityMs = Date.parse(validUntil) - Date.parse(evaluatedAt);
    if (validityMs <= 0 || validityMs > 5 * 60 * 1000 + 1000) {
      throw new Error('invalid dynamic-group preview validity');
    }
    return {
      policyId: uuid(row.policyId),
      policyVersion: integer(row.policyVersion, 1, 2_147_483_647),
      previewFingerprint: dynamicGroupFingerprint(row.previewFingerprint),
      selectorFingerprint: dynamicGroupFingerprint(row.selectorFingerprint),
      membershipStateFingerprint: dynamicGroupFingerprint(row.membershipStateFingerprint),
      evaluatedAt,
      validUntil,
      eligibleCount,
      addedCount,
      removedCount,
      unchangedCount,
      addedSampleUserIds,
      removedSampleUserIds,
      unchangedSampleUserIds,
      nextBoundaryAt: dynamicGroupNullableTimestamp(row.nextBoundaryAt),
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicDynamicGroupPublishReceipt(value: unknown): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, [
      'policyId',
      'policyVersion',
      'publishedVersionId',
      'status',
      'draftState',
      'eligibleCount',
      'addedCount',
      'removedCount',
      'unchangedCount',
      'selectorFingerprint',
      'nextEvaluationAt',
    ]);
    const eligibleCount = integer(row.eligibleCount, 0, 5000);
    const addedCount = integer(row.addedCount, 0, 5000);
    const removedCount = integer(row.removedCount, 0, 5000);
    const unchangedCount = integer(row.unchangedCount, 0, 5000);
    if (
      row.status !== 'active' || row.draftState !== 'published' ||
      addedCount + unchangedCount !== eligibleCount
    ) throw new Error('invalid dynamic-group publish state');
    return {
      policyId: uuid(row.policyId),
      policyVersion: integer(row.policyVersion, 1, 2_147_483_647),
      publishedVersionId: uuid(row.publishedVersionId),
      status: 'active',
      draftState: 'published',
      eligibleCount,
      addedCount,
      removedCount,
      unchangedCount,
      selectorFingerprint: dynamicGroupFingerprint(row.selectorFingerprint),
      nextEvaluationAt: dynamicGroupNullableTimestamp(row.nextEvaluationAt),
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicDynamicGroupPauseReceipt(value: unknown): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    exactDependencyKeys(row, ['policyId', 'policyVersion', 'status', 'pausedAt']);
    if (row.status !== 'paused') throw new Error('invalid dynamic-group pause state');
    return {
      policyId: uuid(row.policyId),
      policyVersion: integer(row.policyVersion, 1, 2_147_483_647),
      status: 'paused',
      pausedAt: dynamicGroupTimestamp(row.pausedAt),
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicGroupCreationCandidates(value: unknown, requestedLimit: number): JsonObject {
  try {
    const root = asObject(toPublicJson(value));
    onlyKeys(root, ['candidates', 'limit']);
    const limit = integer(root.limit, 1, 100);
    if (
      limit !== requestedLimit || !Array.isArray(root.candidates) || root.candidates.length > limit
    ) {
      throw new Error('invalid group candidate receipt');
    }
    const candidates = root.candidates.map((entry) => {
      const row = asObject(entry);
      onlyKeys(row, [
        'userId',
        'displayName',
        'avatarPath',
        'jobTitle',
        'membershipRole',
        'membershipType',
        'accessExpiresAt',
      ]);
      const membershipType = oneOf(
        row.membershipType,
        ['employee', 'contractor', 'guest'] as const,
      );
      const membershipRole = oneOf(
        row.membershipRole,
        ['owner', 'admin', 'manager', 'member'] as const,
      );
      const accessExpiresAt = row.accessExpiresAt === null ? null : isoDate(row.accessExpiresAt);
      if (membershipType === 'guest' && (membershipRole !== 'member' || accessExpiresAt === null)) {
        throw new Error('invalid guest candidate');
      }
      return {
        userId: uuid(row.userId),
        displayName: normalizedString(row.displayName, { min: 1, max: 160 }) as string,
        avatarPath: normalizedString(row.avatarPath, {
          min: 1,
          max: 1024,
          trim: false,
          nullable: true,
        }),
        jobTitle: normalizedString(row.jobTitle, { min: 1, max: 160, nullable: true }),
        membershipRole,
        membershipType,
        accessExpiresAt,
      };
    });
    if (new Set(candidates.map((candidate) => candidate.userId)).size !== candidates.length) {
      throw new Error('duplicate group candidate');
    }
    return { candidates, limit };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicConversationMemberCandidates(value: unknown, requestedLimit: number): JsonObject {
  try {
    const root = asObject(toPublicJson(value));
    exactDependencyKeys(root, ['candidates', 'nextCursor']);
    if (!Array.isArray(root.candidates) || root.candidates.length > requestedLimit) {
      throw new Error('invalid conversation member candidate page');
    }
    const candidates = root.candidates.map((entry) => {
      const row = asObject(entry);
      // The @handle rides along: it is what the picker is searched by, and
      // the client has tolerated the key since v3.1.
      onlyKeys(row, ['userId', 'username', 'displayName', 'avatarPath', 'roleLabel', 'membershipType']);
      const candidate: JsonObject = {
        userId: uuid(row.userId),
        displayName: normalizedString(row.displayName, { min: 1, max: 160 }) as string,
      };
      // A row without a handle omits the key rather than carrying a null.
      if ('username' in row && row.username !== null) {
        candidate.username = normalizedString(row.username, { min: 1, max: 64 }) as string;
      }
      if ('avatarPath' in row) {
        candidate.avatarPath = normalizedString(row.avatarPath, {
          min: 1,
          max: 1024,
          trim: false,
        }) as string;
      }
      if ('roleLabel' in row) {
        candidate.roleLabel = normalizedString(row.roleLabel, { min: 1, max: 160 }) as string;
      }
      if ('membershipType' in row) {
        candidate.membershipType = oneOf(
          row.membershipType,
          ['employee', 'contractor', 'guest'] as const,
        );
      }
      return candidate;
    });
    if (new Set(candidates.map((candidate) => candidate.userId)).size !== candidates.length) {
      throw new Error('duplicate conversation member candidate');
    }
    const nextCursor = root.nextCursor === null
      ? null
      : normalizedString(root.nextCursor, { min: 1, max: 1536, trim: false }) as string;
    if (
      nextCursor !== null &&
      (candidates.length !== requestedLimit || !/^[A-Za-z0-9+/]+={0,2}$/.test(nextCursor))
    ) {
      throw new Error('invalid conversation member candidate cursor');
    }
    return { candidates, nextCursor };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

/**
 * The service found a group with exactly this member set instead of creating
 * another one. Its id is the whole answer; the app offers to open it.
 */
function publicGroupAlreadyExists(value: unknown): JsonObject | null {
  try {
    const row = asObject(value);
    if (row.alreadyExists !== true) return null;
    onlyKeys(row, ['alreadyExists', 'conversationId']);
    return { alreadyExists: true, conversationId: uuid(row.conversationId) };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicGroupCreationReceipt(value: unknown): JsonObject {
  try {
    const row = asObject(value);
    onlyKeys(row, [
      'conversationId',
      'kind',
      'name',
      'description',
      'historyPolicy',
      'historyDisclosure',
      'postingMode',
      'joinPolicy',
      'configuredJoinPolicy',
      'visibility',
      'memberCount',
      'memberLimit',
      'isReadOnly',
    ]);
    const historyPolicy = oneOf(row.historyPolicy, ['all', 'since_join'] as const);
    const historyDisclosure = asObject(row.historyDisclosure);
    onlyKeys(historyDisclosure, ['policy', 'visibleFrom', 'labelKey']);
    const visibleFrom = historyDisclosure.visibleFrom === null
      ? null
      : isoDate(historyDisclosure.visibleFrom);
    const labelKey = oneOf(
      historyDisclosure.labelKey,
      ['conversation.history.all', 'conversation.history.since_join'] as const,
    );
    if (
      historyDisclosure.policy !== historyPolicy ||
      (historyPolicy === 'all' &&
        (visibleFrom !== null || labelKey !== 'conversation.history.all')) ||
      (historyPolicy === 'since_join' &&
        (visibleFrom === null || labelKey !== 'conversation.history.since_join')) ||
      row.isReadOnly !== false
    ) throw new Error('invalid group history receipt');
    const configuredJoinPolicy = oneOf(
      row.configuredJoinPolicy,
      ['inherit', 'invite_only', 'approval_required'] as const,
    );
    const joinPolicy = oneOf(row.joinPolicy, ['invite_only', 'approval_required'] as const);
    if (configuredJoinPolicy !== 'inherit' && configuredJoinPolicy !== joinPolicy) {
      throw new Error('invalid group join receipt');
    }
    const memberLimit = integer(row.memberLimit, 2, 5000);
    const memberCount = integer(row.memberCount, 2, memberLimit);
    return {
      conversationId: uuid(row.conversationId),
      kind: oneOf(row.kind, ['group', 'team', 'shift', 'incident'] as const),
      name: normalizedString(row.name, { min: 1, max: 160 }) as string,
      description: normalizedString(row.description, { min: 1, max: 2000, nullable: true }),
      historyPolicy,
      historyDisclosure: { policy: historyPolicy, visibleFrom, labelKey },
      postingMode: oneOf(row.postingMode, ['all_members', 'admins_only'] as const),
      joinPolicy,
      configuredJoinPolicy,
      visibility: oneOf(row.visibility, ['invite_only', 'organization', 'unit'] as const),
      memberCount,
      memberLimit,
      isReadOnly: false,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicConversationMemberRoleReceipt(value: unknown): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, ['conversationId', 'userId', 'previousRole', 'role']);
    const previousRole = oneOf(row.previousRole, ['owner', 'admin', 'member'] as const);
    const role = oneOf(row.role, ['owner', 'admin', 'member'] as const);
    if (previousRole === role) throw new Error('invalid unchanged conversation role receipt');
    return {
      conversationId: uuid(row.conversationId),
      userId: uuid(row.userId),
      previousRole,
      role,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

const PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_AVATAR_READ_SECONDS = 300;

/** `<organizationId>/<userId>/<uploadId>/avatar` in the private profile-avatars bucket. */
function validateProfileAvatarStoragePath(
  storagePath: string,
  organizationId: string,
  userId: string,
  uploadId: string,
): void {
  const parts = storagePath.split('/');
  if (
    parts.length !== 4 || parts[0] !== organizationId || parts[1] !== userId ||
    parts[2] !== uploadId || parts[3] !== 'avatar' || storagePath.includes('..')
  ) throw new Error('invalid profile avatar storage path');
}

function profileAvatarUploadMetadata(
  value: unknown,
  organizationId: string,
  actorUserId: string,
): { uploadId: string; bucketId: 'profile-avatars'; storagePath: string; maximumByteSize: number } {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, ['uploadId', 'bucketId', 'storagePath', 'maximumByteSize']);
    const uploadId = uuid(row.uploadId);
    const storagePath = normalizedString(row.storagePath, { min: 1, max: 1024, trim: false }) as string;
    if (row.bucketId !== 'profile-avatars' || row.maximumByteSize !== PROFILE_AVATAR_MAX_BYTES) {
      throw new Error('invalid profile avatar upload metadata');
    }
    validateProfileAvatarStoragePath(storagePath, organizationId, actorUserId, uploadId);
    return { uploadId, bucketId: 'profile-avatars', storagePath, maximumByteSize: PROFILE_AVATAR_MAX_BYTES };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function profileAvatarReadMetadata(
  value: unknown,
  organizationId: string,
  userId: string,
): { bucketId: 'profile-avatars'; storagePath: string } {
  let row: JsonObject;
  try {
    row = asObject(toPublicJson(value));
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  if (row.authorized !== true) {
    try {
      onlyKeys(row, ['authorized']);
    } catch {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    throw new ApiError(404, 'not_found');
  }
  try {
    onlyKeys(row, ['authorized', 'userId', 'bucketId', 'storagePath', 'mimeType', 'byteSize']);
    const storagePath = normalizedString(row.storagePath, { min: 1, max: 1024, trim: false }) as string;
    if (
      uuid(row.userId) !== userId || row.bucketId !== 'profile-avatars' ||
      !CONVERSATION_AVATAR_MIME_TYPES.has(String(row.mimeType)) ||
      integer(row.byteSize, 1, PROFILE_AVATAR_MAX_BYTES) !== row.byteSize
    ) throw new Error('invalid profile avatar authorization');
    const parts = storagePath.split('/');
    validateProfileAvatarStoragePath(storagePath, organizationId, userId, uuid(parts[2]));
    return { bucketId: 'profile-avatars', storagePath };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicProfileAvatarActivationReceipt(
  value: unknown,
  organizationId: string,
  userId: string,
  uploadId: string,
  expectedAvatarPath: string | null,
): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, ['userId', 'uploadId', 'avatarPath', 'previousAvatarPath', 'activated']);
    const avatarPath = normalizedString(row.avatarPath, { min: 1, max: 1024, trim: false }) as string;
    const previousAvatarPath = normalizedString(row.previousAvatarPath, {
      min: 1,
      max: 1024,
      trim: false,
      nullable: true,
    });
    if (
      uuid(row.userId) !== userId || uuid(row.uploadId) !== uploadId ||
      previousAvatarPath !== expectedAvatarPath || row.activated !== true
    ) throw new Error('invalid profile avatar activation receipt');
    validateProfileAvatarStoragePath(avatarPath, organizationId, userId, uploadId);
    return { userId, uploadId, avatarPath, previousAvatarPath, activated: true };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicProfileAvatarRemovalReceipt(
  value: unknown,
  userId: string,
  expectedAvatarPath: string,
): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, ['userId', 'previousAvatarPath', 'avatarPath', 'removed']);
    if (
      uuid(row.userId) !== userId || row.previousAvatarPath !== expectedAvatarPath ||
      row.avatarPath !== null || row.removed !== true
    ) throw new Error('invalid profile avatar removal receipt');
    return { userId, previousAvatarPath: expectedAvatarPath, avatarPath: null, removed: true };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function validateConversationAvatarStoragePath(
  storagePath: string,
  organizationId: string,
  conversationId: string,
  attachmentId: string,
  actorUserId?: string,
): void {
  const parts = storagePath.split('/');
  if (
    parts.length !== 5 || parts[0] !== organizationId || parts[1] !== conversationId ||
    (actorUserId !== undefined && parts[2] !== actorUserId) ||
    parts[3] !== attachmentId || parts[4] !== 'upload' || storagePath.includes('..')
  ) throw new Error('invalid conversation avatar storage path');
  uuid(parts[2]);
}

function conversationAvatarUploadMetadata(
  value: unknown,
  organizationId: string,
  conversationId: string,
  actorUserId: string,
): {
  attachmentId: string;
  messageId: string;
  bucketId: 'message-attachments';
  storagePath: string;
  scanStatus: 'pending';
  maximumByteSize: number;
} {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, [
      'attachmentId',
      'messageId',
      'bucketId',
      'storagePath',
      'scanStatus',
      'maximumByteSize',
    ]);
    const attachmentId = uuid(row.attachmentId);
    const bucketId = row.bucketId;
    const storagePath = normalizedString(row.storagePath, {
      min: 1,
      max: 1024,
      trim: false,
    }) as string;
    if (
      bucketId !== 'message-attachments' || row.scanStatus !== 'pending' ||
      row.maximumByteSize !== CONVERSATION_AVATAR_MAX_BYTES
    ) throw new Error('invalid conversation avatar upload metadata');
    validateConversationAvatarStoragePath(
      storagePath,
      organizationId,
      conversationId,
      attachmentId,
      actorUserId,
    );
    return {
      attachmentId,
      messageId: messageId(row.messageId),
      bucketId,
      storagePath,
      scanStatus: 'pending',
      maximumByteSize: CONVERSATION_AVATAR_MAX_BYTES,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function conversationAvatarReadMetadata(
  value: unknown,
  organizationId: string,
  conversationId: string,
  expectedAttachmentId: string,
): { bucketId: 'message-attachments'; storagePath: string } {
  let row: JsonObject;
  try {
    row = asObject(toPublicJson(value));
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  if (row.authorized !== true) {
    try {
      onlyKeys(row, ['authorized']);
    } catch {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    throw new ApiError(404, 'not_found');
  }
  try {
    onlyKeys(row, [
      'authorized',
      'conversationId',
      'attachmentId',
      'bucketId',
      'storagePath',
      'mimeType',
      'byteSize',
    ]);
    const returnedConversationId = uuid(row.conversationId);
    const attachmentId = uuid(row.attachmentId);
    const storagePath = normalizedString(row.storagePath, {
      min: 1,
      max: 1024,
      trim: false,
    }) as string;
    if (
      returnedConversationId !== conversationId || attachmentId !== expectedAttachmentId ||
      row.bucketId !== 'message-attachments' ||
      !CONVERSATION_AVATAR_MIME_TYPES.has(String(row.mimeType)) ||
      integer(row.byteSize, 1, CONVERSATION_AVATAR_MAX_BYTES) !== row.byteSize
    ) throw new Error('invalid conversation avatar authorization');
    validateConversationAvatarStoragePath(
      storagePath,
      organizationId,
      conversationId,
      attachmentId,
    );
    return { bucketId: 'message-attachments', storagePath };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicConversationAvatarActivationReceipt(
  value: unknown,
  organizationId: string,
  conversationId: string,
  attachmentId: string,
  expectedAvatarPath: string | null,
): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, [
      'conversationId',
      'attachmentId',
      'avatarPath',
      'previousAvatarPath',
      'activated',
    ]);
    const avatarPath = normalizedString(row.avatarPath, {
      min: 1,
      max: 1024,
      trim: false,
    }) as string;
    const previousAvatarPath = normalizedString(row.previousAvatarPath, {
      min: 1,
      max: 1024,
      trim: false,
      nullable: true,
    });
    if (
      uuid(row.conversationId) !== conversationId || uuid(row.attachmentId) !== attachmentId ||
      previousAvatarPath !== expectedAvatarPath || row.activated !== true
    ) throw new Error('invalid conversation avatar activation receipt');
    validateConversationAvatarStoragePath(
      avatarPath,
      organizationId,
      conversationId,
      attachmentId,
    );
    return { conversationId, attachmentId, avatarPath, previousAvatarPath, activated: true };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicConversationAvatarRemovalReceipt(
  value: unknown,
  conversationId: string,
  expectedAvatarPath: string,
): JsonObject {
  try {
    const row = asObject(toPublicJson(value));
    onlyKeys(row, [
      'conversationId',
      'previousAvatarPath',
      'avatarPath',
      'removed',
    ]);
    if (
      uuid(row.conversationId) !== conversationId ||
      row.previousAvatarPath !== expectedAvatarPath || row.avatarPath !== null ||
      row.removed !== true
    ) throw new Error('invalid conversation avatar removal receipt');
    return {
      conversationId,
      previousAvatarPath: expectedAvatarPath,
      avatarPath: null,
      removed: true,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

async function publicAuditExport(value: unknown): Promise<unknown> {
  const publicValue = asObject(toPublicJson(value));
  if (publicValue.schemaVersion === 1 && publicValue.denied === true) {
    onlyKeys(publicValue, ['schemaVersion', 'denied']);
    throw new ApiError(403, 'forbidden');
  }
  try {
    const row = publicValue;
    onlyKeys(row, [
      'schemaVersion',
      'receiptId',
      'format',
      'contentType',
      'fileName',
      'rowCount',
      'payloadBytes',
      'sha256',
      'createdAt',
      'payload',
    ]);
    if (integer(row.schemaVersion, 1, 1) !== 1) throw new Error('invalid');
    const format = oneOf(row.format, ['json', 'csv'] as const);
    const contentType = format === 'json' ? 'application/json' : 'text/csv';
    if (row.contentType !== contentType) throw new Error('invalid');
    const fileName = normalizedString(row.fileName, { min: 20, max: 80 }) as string;
    if (!/^newone-audit-[0-9]{8}-[0-9]{6}\.(?:json|csv)$/.test(fileName)) {
      throw new Error('invalid');
    }
    const payload = normalizedString(row.payload, {
      min: 1,
      max: 2_000_000,
      trim: false,
    }) as string;
    const payloadBytes = integer(row.payloadBytes, 1, 2_000_000);
    if (new TextEncoder().encode(payload).byteLength !== payloadBytes) throw new Error('invalid');
    const sha256 = normalizedString(row.sha256, { min: 64, max: 64 }) as string;
    if (!/^[0-9a-f]{64}$/.test(sha256) || await sha256Hex(payload) !== sha256) {
      throw new Error('invalid');
    }
    return {
      receiptId: uuid(row.receiptId),
      format,
      contentType,
      fileName,
      rowCount: integer(row.rowCount, 0, 5000),
      payloadBytes,
      sha256,
      createdAt: isoDate(row.createdAt),
      payload,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicProfile(value: unknown, expectedUserId: string): JsonObject {
  try {
    const row = asObject(value);
    exactDependencyKeys(row, ['user_id', 'display_name', 'status_message']);
    const userId = uuid(row.user_id);
    if (userId !== expectedUserId) throw new Error('profile receipt names another user');
    return {
      userId,
      displayName: normalizedString(row.display_name, { min: 1, max: 120 }) as string,
      statusMessage: normalizedString(row.status_message, { max: 280, nullable: true }),
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function publicConversationPreference(value: unknown): unknown {
  const row = asObject(value);
  const { isHidden, isArchived, ...rest } = row;
  if (typeof isHidden !== 'boolean') {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  // isArchived is its own flag from v3.4. A worker that predates the migration
  // sends only isHidden, and the old meaning stands in until it is deployed.
  return { ...rest, isArchived: typeof isArchived === 'boolean' ? isArchived : isHidden };
}

function publicSessions(value: unknown): unknown {
  try {
    const root = asObject(value);
    if (!Array.isArray(root.sessions) || root.sessions.length > 100) throw new Error('invalid');
    const sessions = root.sessions.map((entry) => {
      const row = asObject(entry);
      const sessionId = uuid(row.session_id);
      const current = bool(row.current);
      const platform = row.platform === null
        ? null
        : oneOf(row.platform, ['ios', 'android', 'web'] as const);
      const timestamp = (input: unknown, nullable = false): string | null => {
        if (input === null && nullable) return null;
        if (typeof input !== 'string' || input.length < 10 || input.length > 40) {
          throw new Error('invalid');
        }
        if (!Number.isFinite(Date.parse(input))) throw new Error('invalid');
        return input;
      };
      let device: unknown = null;
      if (row.device !== null) {
        const rawDevice = asObject(row.device);
        const devicePlatform = oneOf(rawDevice.platform, ['ios', 'android', 'web'] as const);
        if (devicePlatform !== platform) throw new Error('invalid');
        device = {
          installationId: uuid(rawDevice.installation_id),
          platform: devicePlatform,
          appVersion: rawDevice.app_version === null
            ? null
            : normalizedString(rawDevice.app_version, { max: 80 }),
        };
      }
      const signal = asObject(row.signal);
      return {
        sessionId,
        current,
        device,
        platform,
        createdAt: timestamp(row.created_at),
        lastUsedAt: timestamp(row.last_used_at),
        expiresAt: timestamp(row.expires_at, true),
        revoked: bool(row.revoked),
        aal: oneOf(row.aal, ['aal1', 'aal2'] as const),
        signal: {
          sameNetworkAsCurrent: bool(signal.same_network_as_current),
          clientFamily: oneOf(
            signal.client_family,
            ['iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown'] as const,
          ),
        },
      };
    });
    return { sessions };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function attachmentMetadata(value: unknown): {
  attachmentId: string;
  bucketId: string;
  storagePath: string;
} {
  const row = asObject(value);
  const attachmentId = uuid(row.attachmentId ?? row.attachment_id);
  const bucketId = normalizedString(row.bucketId ?? row.bucket_id, { min: 1, max: 100 }) as string;
  const storagePath = normalizedString(row.storagePath ?? row.storage_path, {
    min: 1,
    max: 1024,
    trim: false,
  }) as string;
  if (bucketId !== 'message-attachments' || storagePath.includes('..')) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return { attachmentId, bucketId, storagePath };
}

function attachmentDownloadMetadata(value: unknown, expectedAttachmentId: string): {
  attachmentId: string;
  bucketId: string;
  storagePath: string;
  fileName: string;
} {
  const row = asObject(value);
  if (row.authorized !== true) throw new ApiError(404, 'not_found');
  const metadata = attachmentMetadata(row);
  if (metadata.attachmentId !== expectedAttachmentId) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const fileName = normalizedString(row.file_name, { min: 1, max: 255, trim: false }) as string;
  return { ...metadata, fileName };
}

async function attachmentGrant(
  actor: AuthenticatedActor,
  command: ParsedCommand,
  idempotencyKey: string,
  requestDigest: string,
): Promise<CommandResult> {
  const values = command.values;
  if (values.action === 'upload') {
    const result = await businessRpc(
      actor,
      command.organizationId,
      idempotencyKey,
      requestDigest,
      'bff_create_attachment_upload',
      {
        p_conversation_id: values.conversationId,
        p_message_id: values.messageId,
        p_file_name: values.fileName,
        p_mime_type: values.mimeType,
        p_byte_size: values.byteSize,
        p_sha256_hex: values.sha256Hex,
      },
    );
    const metadata = attachmentMetadata(result);
    const { data, error } = await actor.adminClient.storage.from(metadata.bucketId)
      .createSignedUploadUrl(metadata.storagePath, { upsert: false });
    if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    return {
      status: 201,
      body: {
        grant: {
          action: 'upload',
          attachmentId: metadata.attachmentId,
          bucket: metadata.bucketId,
          path: metadata.storagePath,
          signedUrl: data.signedUrl,
          token: data.token,
          expiresInSeconds: 7200,
        },
      },
    };
  }

  const authorization = await invokeRpc(
    asRpcClient(actor.adminClient),
    'bff_authorize_attachment_download',
    {
      p_actor_user_id: actor.user.id,
      p_organization_id: command.organizationId,
      p_session_id: actor.claims.sessionId,
      p_attachment_id: values.attachmentId,
    },
  );
  const metadata = attachmentDownloadMetadata(authorization, values.attachmentId as string);
  const { data: signed, error: signError } = await actor.adminClient.storage
    .from(metadata.bucketId)
    .createSignedUrl(metadata.storagePath, 120, { download: metadata.fileName });
  if (signError || !signed) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return {
    status: 200,
    body: {
      grant: {
        action: 'download',
        attachmentId: metadata.attachmentId,
        signedUrl: signed.signedUrl,
        expiresInSeconds: 120,
      },
    },
  };
}

function validateCompletionPath(
  organizationId: string,
  actorUserId: string,
  attachmentId: string,
  storagePath: string,
): void {
  const parts = storagePath.split('/');
  if (
    parts.length !== 5 || parts[0] !== organizationId || parts[2] !== actorUserId ||
    parts[3] !== attachmentId || parts[4] !== 'upload'
  ) throw new ApiError(400, 'bad_request');
  uuid(parts[1]);
}

async function completeAttachmentUpload(
  actor: AuthenticatedActor,
  command: ParsedCommand,
  idempotencyKey: string,
  requestDigest: string,
): Promise<CommandResult> {
  const values = command.values;
  const attachmentId = values.attachmentId as string;
  const bucketId = values.bucketId as string;
  const storagePath = values.storagePath as string;
  const byteSize = values.byteSize as number;
  const expectedSha256 = values.sha256Hex as string;
  validateCompletionPath(command.organizationId, actor.user.id, attachmentId, storagePath);

  const bucket = actor.adminClient.storage.from(bucketId);
  const { data: objectInfo, error: infoError } = await bucket.info(storagePath);
  if (infoError || !objectInfo) throw new ApiError(409, 'attachment_not_ready');
  if (objectInfo.size !== byteSize) throw new ApiError(422, 'attachment_integrity_failed');

  const { data: object, error: downloadError } = await bucket.download(storagePath);
  if (downloadError || !object) throw new ApiError(409, 'attachment_not_ready');
  if (object.size !== byteSize || object.size > VIDEO_ATTACHMENT_MAX_BYTES) {
    throw new ApiError(422, 'attachment_integrity_failed');
  }
  const observedSha256 = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
  if (observedSha256 !== expectedSha256) {
    throw new ApiError(422, 'attachment_integrity_failed');
  }

  return {
    status: 202,
    body: await businessRpc(
      actor,
      command.organizationId,
      idempotencyKey,
      requestDigest,
      'bff_finalize_attachment_upload',
      {
        p_attachment_id: attachmentId,
        p_bucket_id: bucketId,
        p_storage_path: storagePath,
        p_object_byte_size: byteSize,
        p_object_sha256_hex: observedSha256,
      },
    ),
  };
}

export async function executeCommand(
  route: MatchedRoute,
  command: ParsedCommand,
  actor: AuthenticatedActor,
  idempotencyKey: string,
  requestDigest: string,
  publicAppUrl?: string,
  cursorSigningKey?: string,
): Promise<CommandResult> {
  const values = command.values;
  const org = command.organizationId;

  switch (route.kind) {
    case 'conversation.direct':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_create_direct_conversation',
          {
            p_other_user_id: values.targetUserId,
          },
        ),
      };
    case 'conversation.group': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        requestDigest,
        'bff_create_group_conversation_v2',
        {
          p_name: values.name,
          p_description: values.description,
          p_member_assignments: values.memberAssignments,
          p_kind: values.kind,
          p_unit_id: values.unitId,
          p_history_policy: values.historyPolicy,
          p_posting_mode: values.postingMode,
          p_join_policy: values.joinPolicy,
          p_incident_severity: values.incidentSeverity,
          p_incident_classification: values.incidentClassification,
        },
      );
      const existing = publicGroupAlreadyExists(result);
      // Nothing was created, so this is not a 201: the app is being sent to
      // the group it already has.
      if (existing) return { status: 200, body: existing };
      return {
        status: 201,
        body: publicGroupCreationReceipt(result),
      };
    }
    case 'conversation.group.candidates':
      return {
        status: 200,
        body: publicGroupCreationCandidates(
          await invokeRpc(
            asRpcClient(actor.adminClient),
            'bff_list_group_creation_candidates',
            {
              p_actor_user_id: actor.user.id,
              p_organization_id: org,
              p_session_id: actor.claims.sessionId,
              p_query: values.query,
              p_limit: values.limit,
            },
          ),
          values.limit as number,
        ),
      };
    case 'conversation.member.candidates': {
      const conversationId = values.conversationId as string;
      const query = values.query as string;
      const limit = values.limit as number;
      const databaseCursor = values.cursor === null
        ? null
        : (await verifyConversationMemberCandidateCursor(
          values.cursor as string,
          {
            organizationId: org,
            actorUserId: actor.user.id,
            conversationId,
            query,
            pageSize: limit,
          },
          cursorSigningKey,
        )).databaseCursor;
      const page = publicConversationMemberCandidates(
        await invokeRpc(
          asRpcClient(actor.adminClient),
          'bff_list_conversation_member_candidates',
          {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_conversation_id: conversationId,
            p_query: query,
            p_cursor: databaseCursor,
            p_limit: limit,
          },
        ),
        limit,
      );
      const nextDatabaseCursor = page.nextCursor;
      return {
        status: 200,
        body: {
          ...page,
          nextCursor: typeof nextDatabaseCursor === 'string'
            ? await signConversationMemberCandidateCursor({
              organizationId: org,
              actorUserId: actor.user.id,
              conversationId,
              query,
              pageSize: limit,
              databaseCursor: nextDatabaseCursor,
            }, cursorSigningKey)
            : null,
        },
      };
    }
    case 'conversation.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_update_conversation',
          {
            p_conversation_id: values.conversationId,
            p_patch: values.patch,
          },
        ),
      };
    case 'conversation.preferences.update':
      return {
        status: 200,
        body: publicConversationPreference(
          await businessRpc(
            actor,
            org,
            idempotencyKey,
            requestDigest,
            'bff_update_conversation_preferences',
            {
              p_conversation_id: values.conversationId,
              p_patch: values.patch,
            },
          ),
        ),
      };
    case 'organization.preferences.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_update_organization_preferences',
          { p_patch: values.patch },
        ),
      };
    case 'conversation.controls.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_update_conversation_controls',
          {
            p_conversation_id: values.conversationId,
            p_posting_mode: values.postingMode,
            p_join_policy: values.joinPolicy,
            p_visibility: values.visibility,
            p_reason: values.reason,
          },
        ),
      };
    case 'conversation.member.add':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_add_conversation_member',
          {
            p_conversation_id: values.conversationId,
            p_target_user_id: values.targetUserId,
            p_role: values.role,
          },
        ),
      };
    case 'conversation.member.remove':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_remove_conversation_member',
          {
            p_conversation_id: values.conversationId,
            p_target_user_id: values.targetUserId,
          },
        ),
      };
    case 'conversation.member.role.update': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        await sha256Hex(
          `${requestDigest}\nconversation-member-role\n${values.conversationId}:${values.targetUserId}`,
        ),
        'bff_update_conversation_member_role',
        {
          p_conversation_id: values.conversationId,
          p_target_user_id: values.targetUserId,
          p_expected_role: values.expectedRole,
          p_new_role: values.newRole,
        },
      );
      const receipt = publicConversationMemberRoleReceipt(result);
      if (
        receipt.conversationId !== values.conversationId ||
        receipt.userId !== values.targetUserId ||
        receipt.previousRole !== values.expectedRole ||
        receipt.role !== values.newRole
      ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return { status: 200, body: receipt };
    }
    case 'profile.avatar.grant': {
      const metadata = profileAvatarUploadMetadata(
        await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(`${requestDigest}\nprofile-avatar-grant\n${actor.user.id}`),
          'bff_create_profile_avatar_upload',
          {
            p_file_name: values.fileName,
            p_mime_type: values.mimeType,
            p_byte_size: values.byteSize,
            p_sha256_hex: values.sha256Hex,
          },
        ),
        org,
        actor.user.id,
      );
      const { data, error } = await actor.adminClient.storage.from(metadata.bucketId)
        .createSignedUploadUrl(metadata.storagePath, { upsert: false });
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return {
        status: 201,
        body: {
          grant: {
            action: 'upload',
            uploadId: metadata.uploadId,
            bucket: metadata.bucketId,
            path: metadata.storagePath,
            maximumByteSize: metadata.maximumByteSize,
            signedUrl: data.signedUrl,
            token: data.token,
            expiresInSeconds: 7200,
          },
        },
      };
    }
    case 'profile.avatar.query': {
      const metadata = profileAvatarReadMetadata(
        await invokeRpc(
          asRpcClient(actor.adminClient),
          'bff_authorize_profile_avatar_download',
          {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_target_user_id: values.userId,
          },
        ),
        org,
        values.userId as string,
      );
      const { data, error } = await actor.adminClient.storage.from(metadata.bucketId)
        .createSignedUrl(metadata.storagePath, PROFILE_AVATAR_READ_SECONDS);
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return {
        status: 200,
        body: {
          userId: values.userId,
          avatarPath: metadata.storagePath,
          signedUrl: data.signedUrl,
          expiresInSeconds: PROFILE_AVATAR_READ_SECONDS,
        },
      };
    }
    case 'profile.avatar.activate': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        await sha256Hex(`${requestDigest}\nprofile-avatar-activate\n${values.uploadId}`),
        'bff_activate_profile_avatar',
        { p_upload_id: values.uploadId, p_expected_avatar_path: values.expectedAvatarPath },
      );
      return {
        status: 200,
        body: publicProfileAvatarActivationReceipt(
          result,
          org,
          actor.user.id,
          values.uploadId as string,
          values.expectedAvatarPath as string | null,
        ),
      };
    }
    case 'profile.avatar.remove': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        await sha256Hex(`${requestDigest}\nprofile-avatar-remove\n${actor.user.id}`),
        'bff_remove_profile_avatar',
        { p_expected_avatar_path: values.expectedAvatarPath },
      );
      return {
        status: 200,
        body: publicProfileAvatarRemovalReceipt(result, actor.user.id, values.expectedAvatarPath as string),
      };
    }
    case 'conversation.avatar.grant': {
      const metadata = conversationAvatarUploadMetadata(
        await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(
            `${requestDigest}\nconversation-avatar-grant\n${values.conversationId}`,
          ),
          'bff_create_conversation_avatar_upload',
          {
            p_conversation_id: values.conversationId,
            p_file_name: values.fileName,
            p_mime_type: values.mimeType,
            p_byte_size: values.byteSize,
            p_sha256_hex: values.sha256Hex,
          },
        ),
        org,
        values.conversationId as string,
        actor.user.id,
      );
      const { data, error } = await actor.adminClient.storage.from(metadata.bucketId)
        .createSignedUploadUrl(metadata.storagePath, { upsert: false });
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return {
        status: 201,
        body: {
          grant: {
            action: 'upload',
            attachmentId: metadata.attachmentId,
            messageId: metadata.messageId,
            bucket: metadata.bucketId,
            path: metadata.storagePath,
            scanStatus: metadata.scanStatus,
            maximumByteSize: metadata.maximumByteSize,
            signedUrl: data.signedUrl,
            token: data.token,
            expiresInSeconds: 7200,
          },
        },
      };
    }
    case 'conversation.avatar.query': {
      const metadata = conversationAvatarReadMetadata(
        await invokeRpc(
          asRpcClient(actor.adminClient),
          'bff_authorize_conversation_avatar_download',
          {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_conversation_id: values.conversationId,
            p_attachment_id: values.attachmentId,
          },
        ),
        org,
        values.conversationId as string,
        values.attachmentId as string,
      );
      const { data, error } = await actor.adminClient.storage.from(metadata.bucketId)
        .createSignedUrl(metadata.storagePath, 120);
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return {
        status: 200,
        body: {
          attachmentId: values.attachmentId,
          signedUrl: data.signedUrl,
          expiresInSeconds: 120,
        },
      };
    }
    case 'conversation.avatar.activate': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        await sha256Hex(
          `${requestDigest}\nconversation-avatar-activate\n${values.conversationId}:${values.attachmentId}`,
        ),
        'bff_activate_conversation_avatar',
        {
          p_conversation_id: values.conversationId,
          p_attachment_id: values.attachmentId,
          p_expected_avatar_path: values.expectedAvatarPath,
        },
      );
      return {
        status: 200,
        body: publicConversationAvatarActivationReceipt(
          result,
          org,
          values.conversationId as string,
          values.attachmentId as string,
          values.expectedAvatarPath as string | null,
        ),
      };
    }
    case 'conversation.avatar.remove': {
      const result = await businessRpc(
        actor,
        org,
        idempotencyKey,
        await sha256Hex(
          `${requestDigest}\nconversation-avatar-remove\n${values.conversationId}`,
        ),
        'bff_remove_conversation_avatar',
        {
          p_conversation_id: values.conversationId,
          p_expected_avatar_path: values.expectedAvatarPath,
        },
      );
      return {
        status: 200,
        body: publicConversationAvatarRemovalReceipt(
          result,
          values.conversationId as string,
          values.expectedAvatarPath as string,
        ),
      };
    }
    case 'conversation.leave':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_leave_conversation',
          {
            p_conversation_id: values.conversationId,
            p_replacement_owner_user_id: values.replacementOwnerUserId,
          },
        ),
      };
    case 'message.send': {
      const rawResult = await businessRpc(
        actor,
        org,
        idempotencyKey,
        requestDigest,
        'bff_send_message',
        {
          p_conversation_id: values.conversationId,
          p_client_nonce: values.clientNonce,
          p_kind: values.kind,
          p_body: values.body,
          p_language_code: values.languageCode,
          p_reply_to_message_id: values.replyToMessageId,
          p_thread_root_message_id: values.threadRootMessageId,
          p_metadata: values.metadata,
        },
      );
      const result = asObject(rawResult);
      const message = result.message && typeof result.message === 'object'
        ? asObject(result.message)
        : result;
      const committedMessageId = messageId(message.messageId ?? message.id);
      const clientMessageId = uuid(
        message.clientMessageId ?? message.clientNonce ?? values.clientNonce,
      );
      if (message.originalCommitted !== true) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      if (!Array.isArray(message.translationTargets) || message.translationTargets.length > 50) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      const translationTargets = message.translationTargets.map(language);
      return {
        status: 201,
        body: {
          messageId: committedMessageId,
          clientMessageId,
          originalCommitted: true,
          translationTargets,
        },
      };
    }
    case 'message.edit':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          values.delete ? 'bff_delete_message' : 'bff_edit_message',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            ...(values.delete ? {} : { p_body: values.body }),
          },
        ),
      };
    case 'message.react':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          values.active ? 'bff_set_message_reaction' : 'bff_remove_message_reaction',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            p_emoji: values.emoji,
          },
        ),
      };
    case 'message.report':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(
            `${requestDigest}\nmessage\n${values.conversationId}:${values.messageId}`,
          ),
          'bff_report_target_v3',
          {
            p_target_type: 'message',
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            p_subject_user_id: null,
            p_category: values.category,
            p_details: values.details,
            p_consent_to_share: values.consentToShare,
            p_context_before: values.contextBefore,
            p_context_after: values.contextAfter,
            p_notice_version: values.noticeVersion,
          },
        ),
      };
    case 'conversation.report':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(`${requestDigest}\ngroup\n${values.conversationId}`),
          'bff_report_target_v3',
          {
            p_target_type: 'group',
            p_conversation_id: values.conversationId,
            p_message_id: null,
            p_subject_user_id: null,
            p_category: values.category,
            p_details: values.details,
            p_consent_to_share: values.consentToShare,
            p_context_before: 0,
            p_context_after: 0,
            p_notice_version: values.noticeVersion,
          },
        ),
      };
    case 'member.report':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(`${requestDigest}\nmember\n${values.subjectUserId}`),
          'bff_report_target_v3',
          {
            p_target_type: 'member',
            p_conversation_id: null,
            p_message_id: null,
            p_subject_user_id: values.subjectUserId,
            p_category: values.category,
            p_details: values.details,
            p_consent_to_share: values.consentToShare,
            p_context_before: 0,
            p_context_after: 0,
            p_notice_version: values.noticeVersion,
          },
        ),
      };
    case 'message.translate':
      return {
        status: 202,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_enqueue_translation',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            p_target_language: values.targetLanguage,
          },
        ),
      };
    case 'message.pin':
      return {
        status: 200,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_set_message_pin', {
          p_conversation_id: values.conversationId,
          p_message_id: values.messageId,
          p_pinned: values.pinned,
        }),
      };
    case 'message.receipt':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_mark_message_receipt',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            p_state: values.state,
          },
        ),
      };
    case 'message.link_preview': {
      const url = values.url as string;
      const digest = await sha256Hex(url);
      const client = asRpcClient(actor.adminClient);
      const args = {
        p_actor_user_id: actor.user.id,
        p_organization_id: org,
        p_session_id: actor.claims.sessionId,
        p_url_sha256: digest,
      };
      const cached = await invokeRpc<Record<string, unknown>>(
        client,
        'bff_link_preview_lookup',
        args,
      );
      if (cached.cached === true) {
        return { status: 200, body: toPublicJson(await withSignedPreviewImage(actor, cached)) };
      }
      // A miss: fetch the page once, on this side, and keep what it said. A
      // page that is slow, gone or not a page at all is simply unavailable —
      // one bad link in a chat must never fail the reader's request.
      const preview = await fetchLinkPreview(url);
      // The thumbnail is fetched here too, on the same terms, and kept in a
      // private bucket. The reader is handed a signed link to our copy, so the
      // site never learns who was sent the link. A thumbnail that is hostile,
      // enormous or not an image simply does not exist: the preview keeps its
      // title and site name either way.
      let imagePath: string | null = null;
      if (preview.imageUrl) {
        const image = await fetchPreviewImage(preview.imageUrl);
        if (image) {
          const candidate = `${digest}.${image.extension}`;
          const stored = await actor.adminClient.storage
            .from(LINK_PREVIEW_IMAGE_BUCKET)
            .upload(candidate, image.bytes, { contentType: image.mime, upsert: true });
          if (!stored.error) imagePath = candidate;
        }
      }
      return {
        status: 200,
        body: toPublicJson(
          await withSignedPreviewImage(
            actor,
            await invokeRpc<Record<string, unknown>>(client, 'bff_link_preview_record', {
              ...args,
              p_url: preview.url,
              p_title: preview.title,
              p_site_name: preview.siteName,
              p_image_url: preview.imageUrl,
              p_status: preview.status,
              p_image_path: imagePath,
            }),
          ),
        ),
      };
    }
    case 'message.hide_for_me':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_hide_message_for_me',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
          },
        ),
      };
    case 'message.forward':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_forward_message',
          {
            p_source_conversation_id: values.sourceConversationId,
            p_source_message_id: values.sourceMessageId,
            p_target_conversation_id: values.targetConversationId,
            p_client_nonce: values.clientNonce,
          },
        ),
      };
    case 'translation.correction.propose':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_propose_translation_correction',
          {
            p_conversation_id: values.conversationId,
            p_message_id: values.messageId,
            p_target_language: values.targetLanguage,
            p_corrected_body: values.correctedBody,
            p_rationale: values.rationale,
          },
        ),
      };
    case 'translation.correction.review':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_review_translation_correction',
          {
            p_correction_id: values.correctionId,
            p_decision: values.decision,
            p_note: values.note,
          },
        ),
      };
    case 'summary.request': {
      const range = values.range === undefined ? null : asObject(values.range);
      return {
        status: 202,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          range ? 'bff_request_conversation_summary_scope' : 'bff_request_conversation_summary',
          range
            ? {
              p_conversation_id: values.conversationId,
              p_scope_kind: range.kind,
              p_scope_subject: range.subject,
              p_from_message_id: range.fromMessageId,
              p_utc_offset_minutes: range.utcOffsetMinutes,
              p_language_code: values.languageCode,
            }
            : {
              p_conversation_id: values.conversationId,
              p_source_message_ids: values.sourceMessageIds,
              p_language_code: values.languageCode,
            },
        ),
      };
    }
    case 'summary.manual.create':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_create_manual_summary',
          {
            p_conversation_id: values.conversationId,
            p_source_message_ids: values.sourceMessageIds,
            p_language_code: values.languageCode,
            p_primary_topic: values.primaryTopic,
            p_summary_body: values.summary,
            p_key_topics: values.keyTopics,
            p_decisions: values.decisions,
            p_action_items: values.actionItems,
            p_ambiguities: values.ambiguities,
          },
        ),
      };
    case 'ai_output.error.report':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_report_ai_output_error',
          {
            p_output_kind: values.outputKind,
            p_translation_id: values.translationId,
            p_summary_id: values.summaryId,
            p_category: values.category,
            p_details: values.details,
            p_high_consequence: values.highConsequence,
            p_quality_use_consent: values.qualityUseConsent,
            p_consent_version: values.consentVersion,
          },
        ),
      };
    case 'ai_output.error_reports.self.query':
      return {
        status: 200,
        body: toPublicJson(
          await invokeRpc(asRpcClient(actor.adminClient), 'bff_list_my_ai_output_error_reports', {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_limit: values.limit,
          }),
        ),
      };
    case 'contact.request':
      return {
        status: 201,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_request_contact', {
          p_target_user_id: values.targetUserId,
        }),
      };
    case 'contact.message_request': {
      // bff_send_message_request carries no idempotency parameters: the pending
      // contact upsert is its own once-per-pair guard, and a repeat attempt
      // raises P0001 (cooldown). Replay protection for the network retry window
      // therefore wraps the atomic RPC with the shared idempotency ledger the
      // command RPCs use internally, keyed by the same header contract.
      const started = await beginIdempotency(
        actor,
        org,
        route.template,
        idempotencyKey,
        requestDigest,
      );
      if (started.state === 'replay') return { status: started.status, body: started.body };
      if (started.state === 'conflict') throw new ApiError(409, 'idempotency_conflict');
      if (started.state === 'in_progress') {
        throw new ApiError(409, 'idempotency_conflict', undefined, started.retryAfterSeconds);
      }
      const result = asObject(
        await invokeRpc(asRpcClient(actor.adminClient), 'bff_send_message_request', {
          p_actor_user_id: actor.user.id,
          p_organization_id: org,
          p_session_id: actor.claims.sessionId,
          p_target_user_id: values.targetUserId,
          p_body: values.body,
        }),
      );
      if (result.connection_status !== 'pending') {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      const body = {
        connectionStatus: 'pending',
        conversationId: uuid(result.conversation_id),
        messageId: messageId(result.message_id),
      };
      await completeIdempotency(
        actor,
        org,
        route.template,
        idempotencyKey,
        requestDigest,
        201,
        body,
      );
      return { status: 201, body };
    }
    case 'contact.respond':
      return {
        status: 200,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_respond_contact', {
          p_other_user_id: values.targetUserId,
          p_status: values.decision,
        }),
      };
    case 'contact.cancel':
      return {
        status: 200,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_remove_contact', {
          p_other_user_id: values.targetUserId,
        }),
      };
    case 'profile.update':
      return {
        status: 200,
        body: publicProfile(
          await invokeRpc(asRpcClient(actor.adminClient), 'bff_update_profile', {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_display_name: values.displayName,
            p_status_message: values.statusMessage,
          }),
          actor.user.id,
        ),
      };
    case 'saved_contact.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_update_saved_contact',
          { p_contact_user_id: values.contactUserId, p_patch: values.patch },
        ),
      };
    case 'saved_contact.remove':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_remove_saved_contact',
          { p_contact_user_id: values.targetUserId },
        ),
      };
    case 'member.block':
    case 'member.unblock':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_set_member_block',
          {
            p_target_user_id: values.targetUserId,
            p_blocked: route.kind === 'member.block',
          },
        ),
      };
    // Muting a person is a personal notification preference: nothing is
    // hidden, so it is its own command rather than a flavour of blocking.
    case 'person.mute':
    case 'person.unmute':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_set_person_mute',
          {
            p_target_user_id: values.targetUserId,
            p_muted: route.kind === 'person.mute',
          },
        ),
      };
    case 'handoff.sign':
      return {
        status: 200,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_sign_handoff', {
          p_handoff_version_id: values.handoffVersionId,
          p_device_id: values.deviceId,
        }),
      };
    case 'handoff.acknowledge':
      return {
        status: 201,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_acknowledge_handoff',
          {
            p_handoff_version_id: values.handoffVersionId,
            p_note: values.note,
            p_device_id: values.deviceId,
          },
        ),
      };
    case 'action.confirm':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_confirm_operational_action',
          {
            p_action_id: values.actionId,
            p_assignee_user_id: values.assigneeUserId,
            p_due_at: values.dueAt,
          },
        ),
      };
    case 'attachment.grant':
      return await attachmentGrant(actor, command, idempotencyKey, requestDigest);
    case 'attachment.complete':
      return await completeAttachmentUpload(actor, command, idempotencyKey, requestDigest);
    case 'attachment.state':
      return {
        status: 200,
        body: toPublicJson(
          await invokeRpc(asRpcClient(actor.adminClient), 'bff_get_attachment_state', {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_session_id: actor.claims.sessionId,
            p_attachment_id: values.attachmentId,
          }),
        ),
      };
    case 'device.register': {
      const protectedToken = await protectPushToken(values.pushToken as string, {
        organizationId: org,
        userId: actor.user.id,
        installationId: values.installationId as string,
      });
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          requestDigest,
          'bff_register_device',
          {
            p_installation_id: values.installationId,
            p_platform: values.platform,
            p_push_token_ciphertext: protectedToken,
            p_push_token_type: values.pushTokenType,
            p_push_project_id: values.pushProjectId,
            p_push_environment: values.pushEnvironment,
            p_app_version: values.appVersion,
            p_locale: values.locale,
          },
        ),
      };
    }
    case 'device.preferences.read':
      return {
        status: 200,
        body: toPublicJson(
          await invokeRpc(
            asRpcClient(actor.adminClient),
            'bff_get_device_notification_preferences',
            {
              p_actor_user_id: actor.user.id,
              p_organization_id: org,
              p_session_id: actor.claims.sessionId,
              p_installation_id: values.installationId,
            },
          ),
        ),
      };
    case 'device.preferences.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(
            `${requestDigest}\ndevice-preferences\n${values.installationId}`,
          ),
          'bff_update_device_notification_preferences',
          {
            p_installation_id: values.installationId,
            p_expected_version: values.expectedVersion,
            p_patch: values.patch,
          },
        ),
      };
    case 'device.mute.read':
      return {
        status: 200,
        body: toPublicJson(
          await invokeRpc(
            asRpcClient(actor.adminClient),
            'bff_get_device_notifications_muted',
            {
              p_actor_user_id: actor.user.id,
              p_organization_id: org,
              p_session_id: actor.claims.sessionId,
              p_installation_id: values.installationId,
            },
          ),
        ),
      };
    case 'device.mute.update':
      return {
        status: 200,
        body: await businessRpc(
          actor,
          org,
          idempotencyKey,
          await sha256Hex(`${requestDigest}\ndevice-mute\n${values.installationId}`),
          'bff_set_device_notifications_muted',
          {
            p_installation_id: values.installationId,
            p_muted: values.muted,
          },
        ),
      };
    case 'session.list':
      return {
        status: 200,
        body: publicSessions(
          await invokeRpc(asRpcClient(actor.adminClient), 'bff_list_sessions', {
            p_actor_user_id: actor.user.id,
            p_organization_id: org,
            p_current_session_id: actor.claims.sessionId,
          }),
        ),
      };
    case 'session.revoke.self':
      return {
        status: 200,
        body: await businessRpc(actor, org, idempotencyKey, requestDigest, 'bff_revoke_session', {
          p_target_session_id: values.targetSessionId,
          p_reason: values.reason,
        }),
      };
  }
  throw new ApiError(500, 'internal_error');
}
