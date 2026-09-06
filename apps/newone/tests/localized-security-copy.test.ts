import { describe, expect, test } from '@jest/globals';

import { aiPolicyCopy } from '@/features/admin/ai-policy-copy';
import { auditCopy } from '@/features/admin/audit-copy';
import { dynamicGroupCopy } from '@/features/admin/dynamic-group-copy';
import {
  moderationCopy,
  moderationMemberSafetyRouteNotice,
  moderationReportConsentNotice,
  moderationTargetReportConsentNotice,
} from '@/features/admin/moderation-copy';
import {
  interpolateRecoveryCopy,
  recoveryCopy,
} from '@/features/admin/recovery-copy';
import { conversationDepartureCopy } from '@/features/chat/conversation-departure-copy';
import { mentionCopy } from '@/features/chat/mention-copy';
import { notificationCopy } from '@/features/chat/notification-copy';
import { translationPreferenceCopy } from '@/features/chat/translation-preference-copy';
import { handoffAcknowledgementCopy } from '@/features/handoffs/handoff-acknowledgement-copy';
import { handoffCorrectionCopy } from '@/features/handoffs/handoff-correction-copy';
import { searchCopy } from '@/features/search/search-copy';
import { outboxCopy } from '@/features/settings/outbox-copy';
import { updateCopy } from '@/features/updates/update-copy';
import { catalogs, type AppLocale, type MessageKey } from '@/i18n/catalog';

const locales: AppLocale[] = ['en', 'ko', 'es'];

function expectDeepCopy(value: unknown, path = 'root') {
  if (typeof value === 'string') {
    expect(value.trim()).not.toBe('');
    return;
  }
  if (typeof value === 'function') return;
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      expectDeepCopy(nested, `${path}.${key}`);
    }
  }
}

describe('localized security and workflow copy', () => {
  test.each(locales)('%s catalog has the exact English key inventory and no blanks', (locale) => {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(Object.keys(catalogs.en).sort());
    expectDeepCopy(catalogs[locale], `catalogs.${locale}`);
  });

  test.each(locales)('%s feature copy remains complete', (locale) => {
    const featureCopies = [
      aiPolicyCopy(locale),
      auditCopy(locale),
      dynamicGroupCopy(locale),
      moderationCopy(locale),
      recoveryCopy(locale),
      conversationDepartureCopy(locale),
      mentionCopy(locale),
      notificationCopy(locale),
      translationPreferenceCopy(locale),
      handoffAcknowledgementCopy(locale),
      handoffCorrectionCopy(locale),
      searchCopy(locale),
      outboxCopy(locale),
      updateCopy(locale),
    ];
    for (const featureCopy of featureCopies) expectDeepCopy(featureCopy);
  });

  test('locale normalization never selects an unsupported audit language', () => {
    expect(auditCopy('ko-KR').title).toBe(auditCopy('ko').title);
    expect(auditCopy('es-MX').title).toBe(auditCopy('es').title);
    expect(auditCopy('fr-FR').title).toBe(auditCopy('en').title);
  });

  test('recovery receipts interpolate known values and retain unknown placeholders', () => {
    expect(interpolateRecoveryCopy(
      'Recorded {recorded} of {required}; keep {unknown}.',
      { recorded: 1, required: 2 },
    )).toBe('Recorded 1 of 2; keep {unknown}.');
  });

  test.each(locales)('%s report consent states the exact disclosed context counts', (locale) => {
    const notice = moderationReportConsentNotice(locale, 1, 2);
    expect(notice).toContain('1');
    expect(notice).toContain('2');
    expect(moderationTargetReportConsentNotice(locale, 'group')).not.toBe(
      moderationTargetReportConsentNotice(locale, 'member'),
    );
    expect(moderationMemberSafetyRouteNotice(locale)).not.toBe('');
  });

  test.each(locales)('%s search action includes the selected result label', (locale) => {
    expect(searchCopy(locale).openResult('Safety team')).toContain('Safety team');
  });
});

describe('consumer-surface catalog copy', () => {
  const workplaceWording = /coworker|company|workplace|employee|shift|organization|administrator/i;
  const consumerKeys: MessageKey[] = [
    'auth.titleReturn', 'auth.subtitleReturn', 'auth.titleSignup', 'auth.subtitleSignup',
    'help.introBody', 'help.onboardingTitle', 'help.onboardingBody', 'help.recoveryBody',
    'help.privacyBody', 'help.translationBody', 'help.safetyBody', 'help.supportTitle',
    'help.supportBody', 'help.supportUnconfigured',
    'status.emptyChatsBodyConsumer', 'status.emptyPeopleConsumer', 'status.emptyPeopleBodyConsumer',
    'chat.chooseBodyConsumer', 'chat.privateConsumer', 'chat.companyMemberConsumer',
    'people.subtitleConsumer', 'people.eyebrowConsumer', 'people.descriptionConsumer',
    'people.blockNoticeConsumer', 'people.reportNoticeConsumer', 'people.reportConsentConsumer',
    'settings.accountVerified', 'settings.preferencesDescriptionConsumer',
    'settings.deviceNotificationsNoteConsumer', 'settings.devicePreferencesBoundaryConsumer',
    'search.subtitleConsumer',
  ];

  test('English consumer copy carries no workplace wording', () => {
    for (const key of consumerKeys) {
      expect(catalogs.en[key]).not.toMatch(workplaceWording);
    }
  });

  test.each(locales)('%s consumer copy is present and distinct from its workspace counterpart', (locale) => {
    for (const key of consumerKeys) {
      expect(catalogs[locale][key].trim()).not.toBe('');
      const workspaceKey = key.replace(/Consumer$/, '') as MessageKey;
      if (workspaceKey !== key) {
        expect(catalogs[locale][key]).not.toBe(catalogs[locale][workspaceKey]);
      }
    }
  });
});
