import {
  currentUser,
  demoConversations,
  demoHandoffs,
  demoMessages,
  demoPeople,
  demoPersonIds,
  demoUpdates,
} from '@/data/demo';
import type {
  CommandRepository,
  ManagedUpdate,
  ReadRepository,
} from '@/data/repositories/contracts';
import type { AiOutputErrorReport, AiRegressionExample } from '@/domain/types';
import type {
  DynamicGroupPolicy,
  DynamicGroupPreviewReceipt,
} from '@/data/repositories/dynamic-group-dto.mjs';
import type { OrganizationAiPolicy } from '@/data/repositories/ai-policy-dto.mjs';

export class DemoReadRepository implements ReadRepository {
  async loadWorkspace() {
    return {
      organizationId: 'demo-organization',
      organizationName: 'Monterrey Plant',
      conversationControlsVersion: 1,
      currentMembershipRole: 'owner' as const,
      organizationPolicy: {
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open' as const,
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: false,
        groupCreationPolicy: 'members' as const,
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 90,
        version: 1,
      },
      currentUser: { ...currentUser, organizationId: 'demo-organization' },
      conversations: demoConversations.map((item) => ({
        ...item,
        organizationId: 'demo-organization',
        canManageConversation: item.canManage === true,
        canManageDynamicGroup: ['group', 'team', 'shift'].includes(item.kind),
      })),
      messages: Object.fromEntries(
        Object.entries(demoMessages).map(([key, value]) => [
          key,
          value.map((message) => ({ ...message })),
        ]),
      ),
      people: demoPeople.map((item) => ({
        ...item,
        membershipId: item.id,
        organizationId: 'demo-organization',
      })),
      units: [
        { unitId: '11111111-1111-4111-8111-111111111111', parentUnitId: null, kind: 'site' as const, name: 'Monterrey Plant' },
        { unitId: '22222222-2222-4222-8222-222222222222', parentUnitId: '11111111-1111-4111-8111-111111111111', kind: 'department' as const, name: 'Operations' },
        { unitId: '33333333-3333-4333-8333-333333333333', parentUnitId: '22222222-2222-4222-8222-222222222222', kind: 'team' as const, name: 'Packaging' },
        { unitId: '55555555-5555-4555-8555-555555555555', parentUnitId: '33333333-3333-4333-8333-333333333333', kind: 'line' as const, name: 'Line 3' },
        { unitId: '44444444-4444-4444-8444-444444444444', parentUnitId: '55555555-5555-4555-8555-555555555555', kind: 'shift' as const, name: 'Night shift' },
      ],
      updates: demoUpdates.map((item) => ({ ...item, recipientCountKnown: true })),
      handoffs: demoHandoffs.map((item) => ({ ...item })),
      summaries: [{
        id: 'demo-summary-packaging-v1',
        conversationId: 'conv-packaging-night',
        versionNumber: 1,
        language: 'en' as const,
        status: 'ready_for_review' as const,
        primaryTopic: 'Line 3 sensor recovery',
        summary: 'Line 3 stopped after an irregular sensor reading. The team cleaned and inspected the area with the guard installed, then returned the line to service.',
        keyTopics: [
          { text: 'Sensor inspection', sourceMessageIds: ['msg-p-1'] },
          { text: 'Safety guard', sourceMessageIds: ['msg-p-2'] },
          { text: 'Restart readiness', sourceMessageIds: ['msg-p-3'] },
        ],
        decisions: [{ text: 'Keep the safety guard installed during all checks.', sourceMessageIds: ['msg-p-2'] }],
        actionItems: [{ title: 'Confirm pallet count before 22:00', owner: 'Daniel Ruiz', dueAt: null, sourceMessageIds: ['msg-p-4'] }],
        ambiguities: [{ text: 'Final pallet count is still pending.', sourceMessageIds: ['msg-p-4'] }],
        sourceMessageIds: ['msg-p-1', 'msg-p-2', 'msg-p-3', 'msg-p-4'],
        sourceFirstMessageId: 'msg-p-1',
        sourceLastMessageId: 'msg-p-4',
        sourceFingerprint: 'a'.repeat(64),
        outputFingerprint: 'b'.repeat(64),
        sourceState: 'current' as const,
        policyState: 'current' as const,
        requestMode: 'manual' as const,
        requestedByUserId: demoPersonIds.woojin,
        correctionOfSummaryId: null,
        provenance: {
          processorType: 'ai' as const,
          provider: 'google-vertex',
          model: 'qwen/qwen3-235b-a22b-2507',
          organizationAiPolicyVersion: 1,
          routePolicyVersion: '2026-08-01',
          providerRoute: 'google-vertex/us-south1',
        },
        failureCode: null,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: '2026-08-03T21:34:00Z',
        generatedAt: '2026-08-03T21:35:00Z',
      }],
      actions: [{
        id: 'demo-action-pallet-count',
        conversationId: 'conv-packaging-night',
        sourceMessageId: 'msg-p-4',
        title: 'Confirm pallet count',
        details: 'Confirm and report the night-shift pallet count.',
        status: 'confirmed' as const,
        proposedByUserId: demoPersonIds.woojin,
        assigneeUserId: demoPersonIds.daniel,
        assigneeName: 'Daniel Ruiz',
        dueAt: '2026-08-03T22:00:00Z',
        createdAt: '2026-08-03T21:35:00Z',
        updatedAt: '2026-08-03T21:36:00Z',
      }],
      moderationReports: [],
      auditEvents: [],
      capabilities: [
        'members.security', 'sessions.revoke', 'roles.manage', 'roles.read', 'audit.read',
        'ai.policy.manage', 'directory.manage', 'directory.read', 'invites.manage',
        'communications.publish', 'unit.manage', 'conversation.manage', 'language.review',
        'recovery.manage',
        'message.preservation.manage',
        'handoff.manage', 'actions.confirm', 'reports.investigate', 'reports.assign',
      ] as import('@/domain/types').WorkspaceCapability[],
      scopes: [],
      messageDisplayLanguage: currentUser.preferredLanguage,
      cursors: {},
      discoverableConversations: [{
        conversationId: 'demo-discoverable-safety',
        kind: 'group' as const,
        name: 'Safety ideas',
        description: 'Open group for workplace safety improvements.',
        avatarPath: null,
        visibility: 'organization' as const,
        postingMode: 'all_members' as const,
        joinPolicy: 'approval_required' as const,
        memberCount: 28,
        historyDisclosure: {
          policy: 'since_join' as const,
          visibleFrom: new Date().toISOString(),
          labelKey: 'conversation.history.since_join' as const,
        },
        myJoinRequest: null,
      }],
    };
  }

  async loadMessages(input: { conversationId: string }) {
    const items = (demoMessages[input.conversationId] ?? []).map((item) => ({ ...item }));
    return { items, cursor: items.at(-1)?.serverId ?? null };
  }

  async queryAudit() {
    const occurredAt = new Date().toISOString();
    return {
      items: [{
        id: '1',
        actorUserId: demoPersonIds.woojin,
        eventType: 'audit.accessed',
        targetType: 'audit_log',
        targetId: 'demo-filter-receipt',
        requestId: null,
        occurredAt,
        outcome: 'succeeded' as const,
      }],
      nextCursor: null,
      hasMore: false,
      snapshotAt: occurredAt,
      filterSha256: 'a'.repeat(64),
      receiptId: '00000000-0000-4000-8000-000000000071',
    };
  }
}

export class DemoCommandRepository implements CommandRepository {
  private aiReports: AiOutputErrorReport[] = [];
  private aiRegressionExamples = new Map<string, AiRegressionExample>();
  private dynamicGroupPolicies = new Map<string, DynamicGroupPolicy>();
  private dynamicGroupPreviews = new Map<string, DynamicGroupPreviewReceipt>();
  private dynamicGroupSequence = 100;
  private organizationAiPolicy: OrganizationAiPolicy = {
    organizationId: 'demo-organization',
    enabled: false,
    policyVersion: 0,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
    tenantApproved: false,
    globalKillSwitchStillRequired: true,
  };
  async exportAudit(input: Parameters<CommandRepository['exportAudit']>[0]) {
    const payload = input.format === 'json' ? '{\n  "events": []\n}' : 'event_id,outcome';
    return {
      receiptId: '00000000-0000-4000-8000-000000000098',
      format: input.format,
      contentType: input.format === 'json' ? 'application/json' as const : 'text/csv' as const,
      fileName: `newone-audit-20260804-120000.${input.format}`,
      rowCount: 0,
      payloadBytes: new TextEncoder().encode(payload).byteLength,
      sha256: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
      payload,
    };
  }

  async createDirectConversation(input: { targetMembershipId: string }) {
    return { conversationId: `demo-direct-${input.targetMembershipId}` };
  }

  async sendMessage(input: { clientMessageId: string }) {
    return {
      messageId: `demo-server-${input.clientMessageId}`,
      clientMessageId: input.clientMessageId,
      cursor: input.clientMessageId,
      translationTargets: [],
    };
  }

  async markMessageReceipt(input: Parameters<CommandRepository['markMessageReceipt']>[0]) {
    const now = new Date().toISOString();
    return {
      conversationId: input.conversationId,
      messageId: input.messageId,
      scope: 'self' as const,
      deliveredAt: now,
      readAt: input.state === 'read' ? now : null,
    };
  }

  async requestTranslation() {
    return { translationId: `demo-translation-${Date.now()}`, status: 'queued' as const, retried: false };
  }

  async proposeTranslationCorrection() {
    return { correctionId: `demo-correction-${Date.now()}`, status: 'pending' as const };
  }

  async reviewTranslationCorrection(
    input: Parameters<CommandRepository['reviewTranslationCorrection']>[0],
  ) {
    return {
      correctionId: input.correctionId,
      decision: input.decision,
      reviewedAt: new Date().toISOString(),
    };
  }

  async requestConversationSummary() {
    return {
      summaryId: `demo-summary-${Date.now()}`,
      versionNumber: 1,
      status: 'queued' as const,
      sourceFingerprint: 'c'.repeat(64),
      deduplicated: false,
    };
  }

  async createManualSummary() {
    return {
      summaryId: `demo-summary-correction-${Date.now()}`,
      versionNumber: 2,
      status: 'draft' as const,
      outputFingerprint: 'd'.repeat(64),
    };
  }

  async reviewConversationSummary(
    input: Parameters<CommandRepository['reviewConversationSummary']>[0],
  ) {
    return {
      summaryId: input.summaryId,
      status: input.decision === 'approve' ? 'approved' as const : 'failed' as const,
      humanReviewed: true as const,
    };
  }

  async reportAiOutputError(
    input: Parameters<CommandRepository['reportAiOutputError']>[0],
  ) {
    const existing = this.aiReports.find((report) =>
      report.outputKind === input.outputKind
      && report.translationId === (input.translationId ?? null)
      && report.summaryId === (input.summaryId ?? null)
      && ['open', 'reviewing'].includes(report.status));
    const now = new Date().toISOString();
    const report: AiOutputErrorReport = existing ?? {
      reportId: `demo-ai-report-${Date.now()}`,
      outputKind: input.outputKind,
      translationId: input.translationId ?? null,
      summaryId: input.summaryId ?? null,
      conversationId: 'conv-packaging-night',
      category: input.category,
      details: input.details,
      highConsequence: input.highConsequence,
      qualityUseConsent: input.qualityUseConsent,
      consentVersion: input.consentVersion,
      targetSourceFingerprint: 'a'.repeat(64),
      targetOutputFingerprint: 'b'.repeat(64),
      targetLanguage: 'en',
      targetSnapshot: input.outputKind === 'translation'
        ? { schemaVersion: 1, translatedBody: 'Demo translated output', sourceLanguage: 'es', targetLanguage: 'en' }
        : { schemaVersion: 1, summaryBody: 'Demo summary output', languageCode: 'en' },
      status: 'open',
      outcome: null,
      version: 1,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!existing) this.aiReports.unshift(report);
    return { ...report, deduplicated: Boolean(existing), originalsUnchanged: true as const };
  }

  async listMyAiOutputErrorReports() {
    return this.aiReports.map((report) => ({ ...report }));
  }

  async listAiOutputErrorReportsForReview() {
    return this.aiReports.filter((report) => ['open', 'reviewing'].includes(report.status));
  }

  async readAiOutputErrorReport(
    input: Parameters<CommandRepository['readAiOutputErrorReport']>[0],
  ) {
    const report = this.aiReports.find((candidate) => candidate.reportId === input.reportId);
    if (!report) throw new Error('Demo AI output report unavailable.');
    return { report: { ...report }, regressionExample: this.aiRegressionExamples.get(report.reportId) ?? null };
  }

  async reviewAiOutputErrorReport(
    input: Parameters<CommandRepository['reviewAiOutputErrorReport']>[0],
  ) {
    const report = this.aiReports.find((candidate) => candidate.reportId === input.reportId);
    if (!report) throw new Error('Demo AI output report unavailable.');
    const reviewed: AiOutputErrorReport = {
      ...report,
      status: input.outcome === 'confirmed_error' ? 'resolved' : input.outcome === 'not_an_error' ? 'dismissed' : 'reviewing',
      outcome: input.outcome,
      reviewNote: input.reviewNote,
      reviewedByUserId: currentUser.id,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: report.version + 1,
    };
    this.aiReports = this.aiReports.map((candidate) => candidate.reportId === report.reportId ? reviewed : candidate);
    return { ...reviewed, originalsUnchanged: true as const };
  }

  async proposeAiRegressionExample(
    input: Parameters<CommandRepository['proposeAiRegressionExample']>[0],
  ) {
    const existing = this.aiRegressionExamples.get(input.reportId);
    if (existing) return { ...existing, deduplicated: true };
    const report = this.aiReports.find((candidate) => candidate.reportId === input.reportId);
    if (!report) throw new Error('Demo AI output report unavailable.');
    const example: AiRegressionExample = {
      exampleId: `demo-ai-example-${Date.now()}`,
      reportId: report.reportId,
      outputKind: report.outputKind,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: report.targetLanguage,
      deidentifiedSourceText: input.deidentifiedSourceText,
      deidentifiedObservedOutput: input.deidentifiedObservedOutput,
      deidentifiedExpectedOutput: input.deidentifiedExpectedOutput,
      errorCategory: report.category,
      consequenceLevel: report.highConsequence ? 'high_consequence' : 'standard',
      attestationVersion: input.attestationVersion,
      proposedByUserId: currentUser.id,
      proposedAt: new Date().toISOString(),
      status: 'pending',
      version: 1,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      exportedAt: null,
    };
    this.aiRegressionExamples.set(report.reportId, example);
    return { ...example, deduplicated: false };
  }

  async decideAiRegressionExample(
    input: Parameters<CommandRepository['decideAiRegressionExample']>[0],
  ) {
    const entry = [...this.aiRegressionExamples.entries()].find(([, example]) => example.exampleId === input.exampleId);
    if (!entry) throw new Error('Demo AI regression example unavailable.');
    const [reportId, example] = entry;
    const decided: AiRegressionExample = {
      ...example,
      status: input.decision,
      version: example.version + 1,
      decidedByUserId: currentUser.id,
      decidedAt: new Date().toISOString(),
      decisionNote: input.decisionNote,
    };
    this.aiRegressionExamples.set(reportId, decided);
    return decided;
  }

  async setSummaryPolicy() {}

  async listGroupCreationCandidates(
    input: Parameters<CommandRepository['listGroupCreationCandidates']>[0],
  ) {
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const limit = input.limit ?? 50;
    const guestExpiry = new Date(Date.now() + 30 * 86400000).toISOString();
    const candidates = demoPeople
      .filter((person) => person.id !== currentUser.id)
      .filter((person) => !query || `${person.displayName} ${person.roleLabel}`.toLocaleLowerCase().includes(query))
      .slice(0, limit)
      .map((person) => ({
        userId: person.id,
        displayName: person.displayName,
        avatarPath: null,
        jobTitle: person.roleLabel,
        membershipRole: person.role === 'manager' ? 'manager' as const : 'member' as const,
        membershipType: person.id === demoPersonIds.luis ? 'guest' as const : 'employee' as const,
        accessExpiresAt: person.id === demoPersonIds.luis ? guestExpiry : null,
      }));
    return { candidates, limit };
  }

  async listConversationMemberCandidates(
    input: Parameters<CommandRepository['listConversationMemberCandidates']>[0],
  ) {
    const conversation = demoConversations.find((item) => item.id === input.conversationId);
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
    if (!conversation || conversation.kind === 'direct' || conversation.archived) {
      return { candidates: [], nextCursor: null };
    }

    const normalize = (value: string) => value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLocaleLowerCase();
    const query = normalize(input.query?.trim().slice(0, 120) ?? '');
    const activeMemberIds = new Set([
      currentUser.id,
      ...(conversation.memberIds ?? []),
      ...(conversation.memberProfiles ?? []).map((member) => member.id),
      ...(demoMessages[input.conversationId] ?? []).map((message) => message.senderId),
    ]);
    const matching = demoPeople
      .filter((person) => !activeMemberIds.has(person.id))
      .filter((person) => !person.suspended && !person.blockedByMe)
      .filter((person) => !query || normalize(`${person.displayName} ${person.roleLabel}`).includes(query))
      .sort((left, right) =>
        normalize(left.displayName).localeCompare(normalize(right.displayName)) ||
        left.id.localeCompare(right.id));

    const cursorPrefix = `demo-member-candidates:${input.conversationId}:`;
    let start = 0;
    if (input.cursor) {
      if (!input.cursor.startsWith(cursorPrefix)) return { candidates: [], nextCursor: null };
      const previousId = input.cursor.slice(cursorPrefix.length);
      const previousIndex = matching.findIndex((person) => person.id === previousId);
      if (previousIndex < 0) return { candidates: [], nextCursor: null };
      start = previousIndex + 1;
    }
    const page = matching.slice(start, start + limit);
    const candidates = page.map((person) => ({
      userId: person.id,
      displayName: person.displayName,
      roleLabel: person.roleLabel,
      membershipType: person.id === demoPersonIds.luis ? 'guest' as const : 'employee' as const,
    }));
    const last = page.at(-1);
    return {
      candidates,
      nextCursor: last && start + page.length < matching.length
        ? `${cursorPrefix}${last.id}`
        : null,
    };
  }

  async createGroupConversation(input: Parameters<CommandRepository['createGroupConversation']>[0]) {
    const effectiveJoinPolicy = input.joinPolicy === 'inherit' ? 'invite_only' as const : input.joinPolicy;
    const visibleFrom = input.historyPolicy === 'since_join' ? new Date().toISOString() : null;
    return {
      conversationId: `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`,
      kind: input.kind,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      historyPolicy: input.historyPolicy,
      historyDisclosure: {
        policy: input.historyPolicy,
        visibleFrom,
        labelKey: input.historyPolicy === 'all'
          ? 'conversation.history.all' as const
          : 'conversation.history.since_join' as const,
      },
      postingMode: input.postingMode,
      joinPolicy: effectiveJoinPolicy,
      configuredJoinPolicy: input.joinPolicy,
      visibility: input.unitId
        ? 'unit' as const
        : effectiveJoinPolicy === 'approval_required'
          ? 'organization' as const
          : 'invite_only' as const,
      memberCount: input.memberAssignments.length + 1,
      memberLimit: 500,
      isReadOnly: false as const,
    };
  }
  async updateConversation() {}
  async updateOrganizationConversationControls() {}
  async updateOrganizationPolicy(
    input: Parameters<CommandRepository['updateOrganizationPolicy']>[0],
  ) {
    const { reason: _reason, ...policy } = input.policy;
    return { ...policy, version: policy.version + 1 };
  }
  async getOrganizationAiPolicy() {
    return {
      ...this.organizationAiPolicy,
      approvedUseCases: [...this.organizationAiPolicy.approvedUseCases],
      providerAllowlist: [...this.organizationAiPolicy.providerAllowlist],
    };
  }
  async updateOrganizationAiPolicy(
    input: Parameters<CommandRepository['updateOrganizationAiPolicy']>[0],
  ) {
    if (input.policy.expectedVersion !== this.organizationAiPolicy.policyVersion) {
      throw new Error('Demo organization AI policy version conflict.');
    }
    this.organizationAiPolicy = {
      organizationId: input.organizationId,
      enabled: input.policy.enabled,
      policyVersion: input.policy.expectedVersion + 1,
      approvedUseCases: [...input.policy.approvedUseCases].sort(),
      providerAllowlist: [...input.policy.providerAllowlist].sort(),
      routePolicy: input.policy.routePolicy,
      tenantApproved: input.policy.enabled,
      globalKillSwitchStillRequired: true,
    };
    return this.getOrganizationAiPolicy();
  }
  async listDynamicGroupPolicies(
    input: Parameters<CommandRepository['listDynamicGroupPolicies']>[0],
  ) {
    const limit = input.limit ?? 50;
    const rows = [...this.dynamicGroupPolicies.values()]
      .filter((policy) => !input.afterPolicyId || policy.policyId > input.afterPolicyId)
      .sort((left, right) => left.policyId.localeCompare(right.policyId));
    const policies = rows.slice(0, limit).map((policy) => ({
      ...policy,
      policySpec: {
        ...policy.policySpec,
        siteIds: [...policy.policySpec.siteIds],
        departmentIds: [...policy.policySpec.departmentIds],
        teamIds: [...policy.policySpec.teamIds],
        lineIds: [...policy.policySpec.lineIds],
        unitIds: [...policy.policySpec.unitIds],
        operationalRoles: [...policy.policySpec.operationalRoles],
        membershipRoles: [...policy.policySpec.membershipRoles],
      },
    }));
    return {
      policies,
      limit,
      nextAfterPolicyId: rows.length > limit ? policies.at(-1)?.policyId ?? null : null,
    };
  }
  async saveDynamicGroupPolicy(
    input: Parameters<CommandRepository['saveDynamicGroupPolicy']>[0],
  ) {
    const now = new Date().toISOString();
    const existing = input.policyId ? this.dynamicGroupPolicies.get(input.policyId) : undefined;
    if (
      (input.policyId === null || input.policyId === undefined)
        ? input.expectedVersion !== 0
        : !existing || existing.version !== input.expectedVersion ||
          existing.conversationId !== input.conversationId
    ) throw new Error('Demo dynamic-group policy version conflict.');
    const conversation = demoConversations.find((item) => item.id === input.conversationId);
    if (!conversation || !['group', 'team', 'shift'].includes(conversation.kind)) {
      throw new Error('Demo dynamic-group conversation is not eligible.');
    }
    const policyId = existing?.policyId ??
      `00000000-0000-4000-8000-${String(++this.dynamicGroupSequence).padStart(12, '0')}`;
    const version = existing ? existing.version + 1 : 1;
    const selectorFingerprint = version.toString(16).padStart(64, 'a').slice(-64);
    const policy: DynamicGroupPolicy = {
      policyId,
      conversationId: input.conversationId,
      conversationName: conversation.title,
      conversationKind: conversation.kind as 'group' | 'team' | 'shift',
      conversationUnitId: null,
      status: existing?.status ?? 'draft',
      version,
      draftState: 'draft',
      policySpec: {
        ...input.policySpec,
        siteIds: [...input.policySpec.siteIds],
        departmentIds: [...input.policySpec.departmentIds],
        teamIds: [...input.policySpec.teamIds],
        lineIds: [...input.policySpec.lineIds],
        unitIds: [...input.policySpec.unitIds],
        operationalRoles: [...input.policySpec.operationalRoles],
        membershipRoles: [...input.policySpec.membershipRoles],
      },
      maximumMembers: input.maximumMembers,
      selectorFingerprint,
      publishedVersionId: existing?.publishedVersionId ?? null,
      lastPreviewFingerprint: null,
      lastPreviewedAt: null,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      nextEvaluationAt: existing?.nextEvaluationAt ?? null,
      sourceChangedAt: existing?.sourceChangedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.dynamicGroupPolicies.set(policyId, policy);
    this.dynamicGroupPreviews.delete(policyId);
    return {
      policyId,
      conversationId: input.conversationId,
      version,
      draftState: 'draft' as const,
      selectorFingerprint,
      requiresPreview: true as const,
      publishedVersionId: policy.publishedVersionId,
    };
  }
  async previewDynamicGroupPolicy(
    input: Parameters<CommandRepository['previewDynamicGroupPolicy']>[0],
  ) {
    const policy = this.dynamicGroupPolicies.get(input.policyId);
    if (!policy || policy.version !== input.expectedVersion) {
      throw new Error('Demo dynamic-group policy version conflict.');
    }
    const evaluatedAt = new Date();
    const previewFingerprint = `${policy.version.toString(16)}f`.padStart(64, 'b').slice(-64);
    const eligibleIds = demoPeople.slice(0, Math.min(5, policy.maximumMembers)).map((person) => person.id);
    const priorIds = policy.publishedVersionId ? eligibleIds.slice(0, 2) : [];
    const unchangedSampleUserIds = [...priorIds].sort();
    const addedSampleUserIds = eligibleIds.filter((id) => !priorIds.includes(id)).sort();
    const receipt: DynamicGroupPreviewReceipt = {
      policyId: policy.policyId,
      policyVersion: policy.version,
      previewFingerprint,
      selectorFingerprint: policy.selectorFingerprint,
      membershipStateFingerprint: `${policy.version.toString(16)}e`.padStart(64, 'c').slice(-64),
      evaluatedAt: evaluatedAt.toISOString(),
      validUntil: new Date(evaluatedAt.getTime() + 5 * 60_000).toISOString(),
      eligibleCount: eligibleIds.length,
      addedCount: addedSampleUserIds.length,
      removedCount: 0,
      unchangedCount: unchangedSampleUserIds.length,
      addedSampleUserIds,
      removedSampleUserIds: [],
      unchangedSampleUserIds,
      nextBoundaryAt: policy.policySpec.shiftMode === 'scheduled'
        ? policy.policySpec.scheduledShiftEndsAt
        : null,
    };
    this.dynamicGroupPreviews.set(policy.policyId, receipt);
    this.dynamicGroupPolicies.set(policy.policyId, {
      ...policy,
      draftState: 'previewed',
      lastPreviewFingerprint: previewFingerprint,
      lastPreviewedAt: receipt.evaluatedAt,
      updatedAt: receipt.evaluatedAt,
    });
    return { ...receipt };
  }
  async publishDynamicGroupPolicy(
    input: Parameters<CommandRepository['publishDynamicGroupPolicy']>[0],
  ) {
    const policy = this.dynamicGroupPolicies.get(input.policyId);
    const preview = this.dynamicGroupPreviews.get(input.policyId);
    if (
      !policy || !preview || policy.version !== input.expectedVersion ||
      preview.policyVersion !== input.expectedVersion ||
      preview.previewFingerprint !== input.previewFingerprint ||
      Date.parse(preview.validUntil) <= Date.now()
    ) throw new Error('Demo dynamic-group preview is stale.');
    const publishedVersionId =
      `00000000-0000-4000-8001-${String(++this.dynamicGroupSequence).padStart(12, '0')}`;
    const now = new Date().toISOString();
    this.dynamicGroupPolicies.set(policy.policyId, {
      ...policy,
      status: 'active',
      draftState: 'published',
      publishedVersionId,
      lastSyncedAt: now,
      nextEvaluationAt: preview.nextBoundaryAt,
      updatedAt: now,
    });
    return {
      policyId: policy.policyId,
      policyVersion: policy.version,
      publishedVersionId,
      status: 'active' as const,
      draftState: 'published' as const,
      eligibleCount: preview.eligibleCount,
      addedCount: preview.addedCount,
      removedCount: preview.removedCount,
      unchangedCount: preview.unchangedCount,
      selectorFingerprint: policy.selectorFingerprint,
      nextEvaluationAt: preview.nextBoundaryAt,
    };
  }
  async pauseDynamicGroupPolicy(
    input: Parameters<CommandRepository['pauseDynamicGroupPolicy']>[0],
  ) {
    const policy = this.dynamicGroupPolicies.get(input.policyId);
    if (!policy || policy.version !== input.expectedVersion || policy.status !== 'active') {
      throw new Error('Demo dynamic-group policy version conflict.');
    }
    const pausedAt = new Date().toISOString();
    this.dynamicGroupPolicies.set(policy.policyId, {
      ...policy,
      status: 'paused',
      nextEvaluationAt: null,
      updatedAt: pausedAt,
    });
    return {
      policyId: policy.policyId,
      policyVersion: policy.version,
      status: 'paused' as const,
      pausedAt,
    };
  }
  async updateConversationControls(
    input: Parameters<CommandRepository['updateConversationControls']>[0],
  ) {
    return {
      conversationId: input.conversationId,
      postingMode: input.postingMode ?? 'all_members' as const,
      configuredJoinPolicy: input.joinPolicy ?? 'inherit' as const,
      joinPolicy: input.visibility === 'invite_only' || input.joinPolicy === 'invite_only'
        ? 'invite_only' as const
        : 'approval_required' as const,
      visibility: input.visibility ?? 'invite_only' as const,
    };
  }
  async requestConversationJoin(input: Parameters<CommandRepository['requestConversationJoin']>[0]) {
    const now = new Date();
    return {
      requestId: `demo-join-${Date.now()}`,
      conversationId: input.conversationId,
      requesterUserId: currentUser.id,
      status: 'pending' as const,
      version: 1,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
    };
  }
  async cancelConversationJoinRequest(
    input: Parameters<CommandRepository['cancelConversationJoinRequest']>[0],
  ) {
    const now = new Date().toISOString();
    return {
      requestId: input.requestId,
      conversationId: 'demo-discoverable-safety',
      requesterUserId: currentUser.id,
      status: 'cancelled' as const,
      version: input.expectedVersion + 1,
      requestedAt: now,
      expiresAt: now,
      decidedAt: now,
    };
  }
  async decideConversationJoinRequest(
    input: Parameters<CommandRepository['decideConversationJoinRequest']>[0],
  ) {
    const now = new Date().toISOString();
    return {
      requestId: input.requestId,
      conversationId: 'conv-packaging-night',
      requesterUserId: demoPersonIds.sofia,
      status: input.decision,
      version: input.expectedVersion + 1,
      requestedAt: now,
      expiresAt: now,
      decidedAt: now,
    };
  }
  async listDiscoverableConversations() {
    return (await new DemoReadRepository().loadWorkspace()).discoverableConversations;
  }
  async listConversationJoinRequests(input: Parameters<CommandRepository['listConversationJoinRequests']>[0]) {
    const now = new Date();
    return [{
      requestId: 'demo-pending-join',
      conversationId: input.conversationId,
      requesterUserId: demoPersonIds.sofia,
      requesterDisplayName: 'Sofía Morales',
      status: 'pending' as const,
      version: 1,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
    }];
  }
  async updateConversationPreferences() {}
  async addConversationMember() {
    return {
      historyVisibleFrom: new Date().toISOString(),
      historyPolicy: 'since_join' as const,
      historyDisclosure: {
        policy: 'since_join' as const,
        visibleFrom: new Date().toISOString(),
        labelKey: 'conversation.history.since_join' as const,
      },
    };
  }
  async removeConversationMember() {}
  async updateConversationMemberRole(
    input: Parameters<CommandRepository['updateConversationMemberRole']>[0],
  ) {
    return {
      conversationId: input.conversationId,
      userId: input.membershipId,
      previousRole: input.expectedRole,
      role: input.newRole,
    };
  }
  async createConversationAvatarUploadGrant(
    input: Parameters<CommandRepository['createConversationAvatarUploadGrant']>[0],
  ) {
    const attachmentId = '70000000-0000-4000-8000-000000000007';
    return {
      action: 'upload' as const,
      attachmentId,
      messageId: '7001',
      bucket: 'message-attachments' as const,
      path: `${input.organizationId}/${input.conversationId}/demo-user/${attachmentId}/upload`,
      scanStatus: 'pending' as const,
      maximumByteSize: 5242880 as const,
      signedUrl: 'https://example.invalid/storage/v1/object/upload/sign/message-attachments/demo?token=demo',
      token: 'demo',
      expiresInSeconds: 7200 as const,
    };
  }
  async getConversationAvatarReadGrant(
    input: Parameters<CommandRepository['getConversationAvatarReadGrant']>[0],
  ) {
    return {
      attachmentId: input.attachmentId,
      signedUrl: 'https://example.invalid/storage/v1/object/sign/message-attachments/demo?token=demo',
      expiresInSeconds: 120 as const,
    };
  }
  async activateConversationAvatar(
    input: Parameters<CommandRepository['activateConversationAvatar']>[0],
  ) {
    return {
      conversationId: input.conversationId,
      attachmentId: input.attachmentId,
      avatarPath: `${input.organizationId}/${input.conversationId}/demo-user/${input.attachmentId}/upload`,
      previousAvatarPath: input.expectedAvatarPath,
      activated: true as const,
    };
  }
  async removeConversationAvatar(
    input: Parameters<CommandRepository['removeConversationAvatar']>[0],
  ) {
    return {
      conversationId: input.conversationId,
      previousAvatarPath: input.expectedAvatarPath,
      avatarPath: null,
      removed: true as const,
    };
  }
  async leaveConversation(input: Parameters<CommandRepository['leaveConversation']>[0]) {
    return {
      conversationId: input.conversationId,
      left: true as const,
      roleAtDeparture: 'member' as const,
      ownershipTransferred: Boolean(input.replacementOwnerMembershipId),
      historyPreserved: true as const,
      futureAccessRevoked: true as const,
      leftAt: new Date().toISOString(),
    };
  }
  async closeIncident() {}
  async editMessage() {}
  async deleteMessage() {}
  async hideMessageForMe() {}
  async forwardMessage(input: { clientMessageId: string }) {
    return { messageId: `demo-forward-${input.clientMessageId}`, clientMessageId: input.clientMessageId };
  }
  async placeMessagePreservationHold(input: { messageId: string; holdType: 'legal' | 'incident_preservation' }) {
    return {
      holdId: '00000000-0000-4000-8000-000000000099',
      messageId: input.messageId,
      holdType: input.holdType,
      active: true as const,
    };
  }
  async releaseMessagePreservationHold(input: { holdId: string }) {
    return {
      holdId: input.holdId,
      messageId: '101',
      active: false as const,
      releasedAt: new Date().toISOString(),
    };
  }
  async setMessageReaction() {}
  async setMessagePin() {}
  async reportMessage(input: Parameters<CommandRepository['reportMessage']>[0]) {
    return {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      status: 'open' as const,
      targetType: 'message' as const,
      created: true,
      reporterIdentityProtected: true as const,
      targetNotNotified: true as const,
      noticeVersion: input.noticeVersion,
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
    };
  }
  async reportGroup(input: Parameters<CommandRepository['reportGroup']>[0]) {
    return {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      status: 'open' as const,
      targetType: 'group' as const,
      created: true,
      reporterIdentityProtected: true as const,
      targetNotNotified: true as const,
      noticeVersion: input.noticeVersion,
      contextBefore: 0 as const,
      contextAfter: 0 as const,
    };
  }
  async reportMember(input: Parameters<CommandRepository['reportMember']>[0]) {
    return {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      status: 'open' as const,
      targetType: 'member' as const,
      created: true,
      reporterIdentityProtected: true as const,
      targetNotNotified: true as const,
      noticeVersion: input.noticeVersion,
      contextBefore: 0 as const,
      contextAfter: 0 as const,
    };
  }
  async createAttachmentUploadGrant() {
    return {
      action: 'upload' as const,
      attachmentId: `demo-attachment-${Date.now()}`,
      bucket: 'message-attachments' as const,
      path: 'demo/local',
      signedUrl: 'demo://upload',
      token: 'demo',
      expiresInSeconds: 7200,
    };
  }
  async createAttachmentDownloadGrant(input: { attachmentId: string }) {
    return {
      action: 'download' as const,
      attachmentId: input.attachmentId,
      signedUrl: 'demo://download',
      expiresInSeconds: 120,
    };
  }
  async completeAttachmentUpload(input: { attachmentId: string }) {
    return {
      attachmentId: input.attachmentId,
      scanStatus: 'pending' as const,
      scanJobId: `demo-scan-${input.attachmentId}`,
    };
  }
  async getAttachmentState(input: { attachmentId: string }) {
    return { attachmentId: input.attachmentId, scanStatus: 'clean' as const };
  }
  async publishUpdate(input: Parameters<CommandRepository['publishUpdate']>[0]) {
    const id = `demo-update-${Date.now()}`;
    return {
      announcementId: id,
      versionId: `${id}-v1`,
      messageId: `demo-message-${id}`,
      status: input.scheduledAt ? 'scheduled' as const : 'published' as const,
      scheduledAt: input.scheduledAt ?? null,
      audienceCount: input.scheduledAt ? 0 : demoPeople.length,
    };
  }
  async previewUpdateAudience(input: Parameters<CommandRepository['previewUpdateAudience']>[0]) {
    return {
      audienceCount: demoPeople.length,
      excludedCount: 0,
      sampleUserIds: demoPeople.slice(0, 5).map((person) => person.id),
      sample: demoPeople.slice(0, 5).map((person) => ({
        userId: person.id,
        displayName: person.displayName,
        preferredLanguage: person.preferredLanguage,
        membershipRole: person.role === 'org_admin'
          ? 'admin' as const
          : person.role === 'manager' || person.role === 'supervisor'
            ? 'manager' as const
            : 'member' as const,
        unitIds: [],
        currentShift: person.presence === 'online',
      })),
      notificationLanguages: [...new Set(demoPeople.map((person) => person.preferredLanguage))],
      exclusionCounts: { inactiveMembers: 0, selectorMismatch: 0 },
      normalizedSpec: input.audienceSpec,
      snapshotBasis: 'active_members_at_publish' as const,
      generatedAt: new Date().toISOString(),
    };
  }
  async cancelScheduledUpdate() {}
  async acknowledgeUpdate() {}
  async markUpdateRead(input: Parameters<CommandRepository['markUpdateRead']>[0]) {
    const timestamp = new Date().toISOString();
    return { announcementId: input.announcementId, readAt: timestamp, deliveredAt: timestamp };
  }
  async correctUpdate(input: Parameters<CommandRepository['correctUpdate']>[0]) {
    return {
      announcementId: input.announcementId,
      versionId: `${input.announcementId}-v${Date.now()}`,
      versionNumber: 2,
      messageId: `demo-corrected-message-${Date.now()}`,
    };
  }
  async listManagedUpdates() {
    const updates: ManagedUpdate[] = demoUpdates.map((update) => ({
      announcementId: update.id,
      conversationId: 'conv-safety',
      conversationTitle: 'Safety · Plant 2',
      versionId: update.versionId,
      versionNumber: update.versionNumber,
      versionCount: update.versionNumber,
      title: update.title,
      body: update.body,
      languageCode: 'en',
      priority: update.severity === 'critical'
        ? 'emergency'
        : update.severity === 'important'
        ? 'important'
        : 'normal',
      notificationClass: update.notificationClass ?? 'routine',
      criticalCategory: update.notificationClass === 'routine' ? null : 'safety',
      quietHoursOverrideReason: update.notificationClass === 'routine'
        ? null
        : 'Demo authorized operational notice',
      requiresAcknowledgement: update.acknowledgementRequired,
      acknowledgementSchema: update.acknowledgementSchema ?? {
        schemaVersion: 1,
        attestationRequired: false,
        attestationPrompt: null,
        requiredKeys: [],
        carryForwardOnCorrection: false,
      },
      reminderPolicy: update.reminderPolicy ?? {
        enabled: false,
        deadlineAt: null,
        intervalSeconds: null,
        maximumReminders: 0,
        escalateAfterSeconds: null,
        smsFallback: false,
      },
      status: update.status === 'scheduled' || update.status === 'cancelled'
        ? update.status
        : 'published',
      scheduledAt: update.scheduledAt ?? null,
      publishedAt: update.status === 'scheduled' ? null : new Date().toISOString(),
      expiresAt: null,
      cancelledAt: null,
      cancellationReason: null,
      correctionOfVersionId: null,
      correctionReason: null,
      audienceSnapshotted: update.status !== 'scheduled',
      recipientCount: update.recipientCount,
      deliveredCount: Math.max(update.acknowledgedCount, Math.floor(update.recipientCount * 0.9)),
      readCount: Math.max(update.acknowledgedCount, Math.floor(update.recipientCount * 0.75)),
      acknowledgedCount: update.acknowledgedCount,
      nonAcknowledgedCount: update.acknowledgementRequired
        ? Math.max(0, update.recipientCount - update.acknowledgedCount)
        : 0,
      overdueCount: 0,
      unreachableCount: Math.max(0, Math.floor(update.recipientCount * 0.05)),
      versions: [{
        versionId: update.versionId,
        versionNumber: update.versionNumber,
        title: update.title,
        body: update.body,
        publishedAt: new Date().toISOString(),
        correctionOfVersionId: null,
        correctionReason: null,
        createdByUserId: currentUser.id,
        createdByDisplayName: update.author,
      }],
    }));
    return {
      updates,
      generatedAt: new Date().toISOString(),
      smsFallbackAvailable: false as const,
    };
  }
  async listUpdateNonAcknowledgers(
    input: Parameters<CommandRepository['listUpdateNonAcknowledgers']>[0],
  ) {
    const people = demoPeople.slice(0, 3).map((person) => ({
      userId: person.id,
      displayName: person.displayName,
      preferredLanguage: person.preferredLanguage,
      membershipStatus: 'active' as const,
      deliveredAt: null,
      readAt: null,
      reminderCount: 1,
      lastRemindedAt: new Date().toISOString(),
      escalatedAt: null,
      reachability: 'pending' as const,
      overdue: false,
    }));
    return {
      announcementId: input.announcementId,
      versionId: `${input.announcementId}-v1`,
      versionNumber: 1,
      deadlineAt: null,
      people,
      hasMore: false,
      nextAfterUserId: null,
      privacyScope: 'notice_response_state_only' as const,
    };
  }
  async createHandoff() {
    const id = `demo-handoff-${Date.now()}`;
    return { handoffId: id, versionId: `${id}-v1` };
  }
  async correctHandoff(input: Parameters<CommandRepository['correctHandoff']>[0]) {
    return {
      handoffId: input.handoffId,
      versionId: `${input.handoffId}-v${input.expectedVersionNumber + 1}`,
      versionNumber: input.expectedVersionNumber + 1,
      status: 'draft' as const,
      requiresSignature: true as const,
      sourceMessageIds: [...input.sourceMessageIds],
      sourceFingerprint: 'd'.repeat(64),
      sourceState: 'current' as const,
      acknowledgementDueAt: input.acknowledgementDueAt,
      reminderState: 'not_due' as const,
      escalationState: 'not_due' as const,
      smsFallbackAvailable: false as const,
    };
  }
  async signHandoff() {}
  async acknowledgeHandoff() {}
  async proposeAction() { return { actionId: `demo-action-${Date.now()}` }; }
  async confirmAction() {}
  async transitionAction() {}
  async requestConnection() {}
  async respondConnection() {}
  async removeConnection() {}
  async saveContact(input: { alias?: string | null; isFavorite?: boolean }) {
    return { alias: input.alias ?? null, isFavorite: input.isFavorite === true };
  }
  async removeSavedContact() {}
  async setPersonBlocked() {}
  async queryRoleAssignments(input: { targetMembershipId: string }) {
    return input.targetMembershipId === demoPersonIds.daniel ? [{
      assignmentId: 'demo-role-daniel-supervisor',
      userId: demoPersonIds.daniel,
      roleName: 'supervisor' as const,
      scopeType: 'organization' as const,
      unitId: null,
      grantedAt: '2026-07-15T14:00:00Z',
      expiresAt: null,
      revokedAt: null,
      active: true,
    }] : [];
  }
  async assignAdminRole(input: { targetMembershipId: string; roleName: import('@/domain/types').AdminRoleName; scopeType: 'organization' | 'unit'; unitId: string | null; expiresAt: string | null }) {
    return {
      assignmentId: `demo-role-${Date.now()}`,
      userId: input.targetMembershipId,
      roleName: input.roleName,
      scopeType: input.scopeType,
      unitId: input.unitId,
      grantedAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      active: true,
    };
  }
  async revokeAdminRole() {}
  async issueInvitation(input: {
    destinationType: 'email' | 'phone';
    destination: string;
    employeeCode?: string | null;
    activationMode: 'otp' | 'manual';
    role: 'admin' | 'manager' | 'member';
    expiresInSeconds: number;
    membershipType: 'employee' | 'contractor' | 'guest';
    membershipAccessExpiresAt: string | null;
    guestSponsorUserId: string | null;
  }) {
    return {
      inviteId: `demo-invite-${Date.now()}`,
      destinationType: input.destinationType,
      destinationMasked: input.destinationType === 'email' ? 'e••••••@company.com' : '••• ••• 0192',
      role: input.role,
      activationMode: input.activationMode,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      activationToken: input.activationMode === 'manual' ? 'd'.repeat(64) : null,
      employeeCode: input.employeeCode ?? null,
      membershipType: input.membershipType,
      membershipAccessExpiresAt: input.membershipAccessExpiresAt,
      guestSponsorUserId: input.guestSponsorUserId,
    };
  }
  async revokeSession() {}
  async loadOrganizationPreferences() {
    return {
      uiLanguage: 'en' as const,
      messageLanguage: null,
      timeZone: 'America/Monterrey',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietDays: [0, 6],
      notificationPreview: 'generic' as const,
      soundEnabled: true,
      vibrationEnabled: true,
      shiftAwareSuppression: true,
      readVisibility: 'contacts' as const,
    };
  }
  async updateOrganizationPreferences(input: { patch: Partial<import('@/domain/types').OrganizationPreferences> }) {
    return { ...(await this.loadOrganizationPreferences()), ...input.patch };
  }
  async listSessions() { return []; }
  async suspendMember() {}
  async getDeviceNotificationPreferences(input: { installationId: string }) {
    return {
      registered: true as const,
      deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      installationId: input.installationId,
      platform: 'ios' as const,
      preferenceVersion: 1,
      overrides: {
        notificationPreview: null,
        soundEnabled: null,
        vibrationEnabled: null,
      },
      effective: {
        notificationPreview: 'generic' as const,
        soundEnabled: true,
        vibrationEnabled: true,
      },
      updatedAt: new Date().toISOString(),
    };
  }
  async updateDeviceNotificationPreferences(input: {
    installationId: string;
    expectedVersion: number;
    patch: import('@/data/repositories/device-notification-preferences-dto.mjs').DeviceNotificationPreferencePatch;
  }) {
    const current = await this.getDeviceNotificationPreferences(input);
    const overrides = { ...current.overrides, ...input.patch };
    return {
      ...current,
      preferenceVersion: input.expectedVersion + 1,
      overrides,
      effective: {
        notificationPreview: overrides.notificationPreview ?? 'generic',
        soundEnabled: overrides.soundEnabled ?? true,
        vibrationEnabled: overrides.vibrationEnabled ?? true,
      },
      updatedAt: new Date().toISOString(),
    };
  }
  async registerDevice() {}
}
