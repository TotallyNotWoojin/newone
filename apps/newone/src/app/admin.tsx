import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppScaffold, DesktopPageHeader, MobileBrandHeader } from '@/components/navigation/app-scaffold';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Avatar, Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { WorkspaceStatePanel, WorkspaceStatusBanner } from '@/components/workspace/workspace-state';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useI18n } from '@/i18n/provider';
import type { AdminRoleName } from '@/domain/types';
import type { IssuedInvitation } from '@/data/repositories/contracts';
import type { GroupCreationCandidate } from '@/data/repositories/group-creation-dto.mjs';
import { AccountRecoverySection } from '@/features/admin/account-recovery-section';
import { AuditAccessSection } from '@/features/admin/audit-access-section';
import { ModerationCaseSection } from '@/features/admin/moderation-case-section';
import { MessagePreservationSection } from '@/features/admin/message-preservation-section';
import { AiQualityReviewSection } from '@/features/admin/ai-quality-review-section';
import { OrganizationPolicySection } from '@/features/admin/organization-policy-section';
import { DynamicGroupSection } from '@/features/admin/dynamic-group-section';
import { ManagedConversationSection } from '@/features/admin/managed-conversation-section';
import { AiPolicySection } from '@/features/admin/ai-policy-section';
import { canAccessAdminSurface } from '@/features/admin/admin-access';
import { useAuth } from '@/state/auth';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

export default function AdminScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const auth = useAuth();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const { t } = useI18n();
  const { currentUser } = workspace;
  const [suspendPersonId, setSuspendPersonId] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [rolePersonId, setRolePersonId] = useState('');
  const [roleName, setRoleName] = useState<AdminRoleName>('employee');
  const [roleScope, setRoleScope] = useState<'organization' | 'unit'>('organization');
  const [roleUnitId, setRoleUnitId] = useState('');
  const [roleExpiresAt, setRoleExpiresAt] = useState('');
  const [roleReason, setRoleReason] = useState('');
  const [roleExpirationFloor] = useState(() => Date.now());
  const [revokeAssignmentId, setRevokeAssignmentId] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  const [inviteVisible, setInviteVisible] = useState(false);
  const [inviteDestinationType, setInviteDestinationType] = useState<'email' | 'phone'>('email');
  const [inviteDestination, setInviteDestination] = useState('');
  const [inviteActivationMode, setInviteActivationMode] = useState<'otp' | 'manual'>('otp');
  const [inviteEmployeeCode, setInviteEmployeeCode] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'manager' | 'member'>('member');
  const [inviteExpiry, setInviteExpiry] = useState(604800);
  const [inviteMembershipType, setInviteMembershipType] = useState<'employee' | 'contractor' | 'guest'>('employee');
  const [inviteAccessDays, setInviteAccessDays] = useState<30 | 90 | 365>(90);
  const [inviteSponsorUserId, setInviteSponsorUserId] = useState('');
  const [inviteSponsorCandidates, setInviteSponsorCandidates] = useState<GroupCreationCandidate[]>([]);
  const [issuedInvitation, setIssuedInvitation] = useState<IssuedInvitation | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  if (!currentUser) {
    return (
      <AppScaffold
        current="admin"
        mobileHeader={<MobileBrandHeader subtitle={t('admin.controls')} title={t('admin.shortTitle')} />}>
        <WorkspaceStatusBanner />
        <WorkspaceStatePanel resource="people" />
      </AppScaffold>
    );
  }

  const suspendPerson = workspace.people.find((person) => person.id === suspendPersonId);
  const rolePerson = workspace.people.find((person) => person.id === rolePersonId);
  const roleExpirationTimestamp = roleExpiresAt.trim() ? Date.parse(roleExpiresAt.trim()) : null;
  const roleExpirationValid = roleExpirationTimestamp === null
    || (Number.isFinite(roleExpirationTimestamp) && roleExpirationTimestamp > roleExpirationFloor);
  const privilegedReady = auth.assuranceLevel === 'aal2';
  const normalizedInviteDestination = inviteDestinationType === 'email'
    ? inviteDestination.trim().toLocaleLowerCase()
    : inviteDestination.replace(/[\s().-]/g, '');
  const inviteDestinationValid = inviteDestinationType === 'email'
    ? /^\S+@\S+\.\S+$/.test(normalizedInviteDestination)
    : /^\+[1-9][0-9]{7,14}$/.test(normalizedInviteDestination);
  const inviteEmployeeCodeValid = inviteActivationMode === 'otp'
    || (inviteEmployeeCode.trim().length >= 3 && inviteEmployeeCode.trim().length <= 64);
  const inviteAccessDurationValid = inviteMembershipType === 'employee'
    || inviteAccessDays * 24 * 60 * 60 > inviteExpiry;
  const inviteSponsorOptions = [
    { userId: currentUser.id, displayName: currentUser.displayName },
    ...inviteSponsorCandidates
      .filter((candidate) => candidate.membershipType !== 'guest')
      .map((candidate) => ({ userId: candidate.userId, displayName: candidate.displayName })),
  ].filter((candidate, index, candidates) =>
    candidate.userId !== 'loading'
    && candidates.findIndex((item) => item.userId === candidate.userId) === index
  );
  const issuedGuestSponsorName = issuedInvitation?.guestSponsorUserId
    ? inviteSponsorOptions.find((candidate) => candidate.userId === issuedInvitation.guestSponsorUserId)
      ?.displayName ?? issuedInvitation.guestSponsorUserId
    : null;
  const roleLabels: Record<AdminRoleName, string> = {
    security_admin: t('admin.roleSecurityAdmin'),
    people_admin: t('admin.rolePeopleAdmin'),
    communications_publisher: t('admin.rolePublisher'),
    site_admin: t('admin.roleSiteAdmin'),
    language_reviewer: t('admin.roleLanguageReviewer'),
    supervisor: t('admin.roleSupervisor'),
    employee: t('admin.roleEmployee'),
    designated_investigator: t('admin.roleInvestigator'),
  };
  const groupCount = workspace.conversations.filter((item) => item.kind !== 'direct').length;
  const openAcknowledgements = workspace.updates.filter(
    (item) => item.acknowledgementRequired && !item.acknowledged,
  ).length;
  const canOpenAdmin = canAccessAdminSurface(workspace.capabilities);

  const openRoles = (personId: string) => {
    workspace.clearActionError();
    setRolePersonId(personId);
    setRoleName('employee');
    setRoleScope('organization');
    setRoleUnitId('');
    setRoleExpiresAt('');
    setRoleReason('');
    void workspace.loadRoleAssignments(personId);
  };

  const closeIssuedInvitation = () => {
    setIssuedInvitation(null);
    if (inviteCopied) void Clipboard.setStringAsync('');
    setInviteCopied(false);
  };

  if (!canOpenAdmin) {
    return (
      <AppScaffold
        current="people"
        mobileHeader={<MobileBrandHeader subtitle={t('admin.restricted')} title={t('admin.administration')} />}>
        <View style={styles.deniedPage}>
          <View style={styles.deniedIcon}>
            <Ionicons name="lock-closed" size={24} color={colors.amber} />
          </View>
          <Text accessibilityRole="header" style={styles.deniedTitle}>{t('admin.required')}</Text>
          <Text style={styles.deniedText}>
            {t('admin.requiredBody')}
          </Text>
        </View>
      </AppScaffold>
    );
  }

  return (
    <AppScaffold
      current="admin"
      mobileHeader={<MobileBrandHeader subtitle={t('admin.controls')} title={t('admin.shortTitle')} />}>
      <WorkspaceStatusBanner />
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        showsVerticalScrollIndicator={false}>
        {desktop ? (
          <DesktopPageHeader
            description={t('admin.description')}
            eyebrow={workspace.organizationName}
            title={t('admin.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
          <View style={styles.securityBanner}>
            <View style={styles.securityBannerIcon}>
              <Ionicons name="shield-checkmark" size={24} color={colors.mintDark} />
            </View>
            <View style={styles.securityBannerCopy}>
              <Text style={styles.securityBannerTitle}>{t('admin.serverControls')}</Text>
              <Text style={styles.securityBannerText}>
                {t('admin.serverControlsBody')}
              </Text>
              <Text style={styles.securityBannerText}>
                {privilegedReady ? t('admin.aal2Detected') : t('admin.aal2Required')}
              </Text>
            </View>
            <View style={styles.securityBannerActions}>
              <StatusBadge
                icon={privilegedReady ? 'shield-checkmark' : 'lock-closed'}
                label={privilegedReady ? t('admin.aal2Ready') : t('admin.aal2Locked')}
                tone={privilegedReady ? 'success' : 'warning'}
              />
              {!privilegedReady ? (
                <PrimaryButton
                  icon="shield-outline"
                  label={t('admin.verifyNow')}
                  onPress={() => router.push('/settings')}
                  tone="light"
                />
              ) : null}
            </View>
          </View>

          <View style={styles.metricsGrid}>
            <MetricCard
              icon="people"
              label={t('admin.activeMembers')}
              note={t('admin.activeMembersNote')}
              value={String(workspace.people.filter((person) => !person.suspended).length)}
            />
            <MetricCard
              icon="chatbubbles"
              label={t('admin.visibleGroups')}
              note={t('admin.visibleGroupsNote')}
              value={String(groupCount)}
            />
            <MetricCard
              icon="warning"
              label={t('admin.openAcknowledgements')}
              note={t('admin.openAcknowledgementsNote')}
              tone="danger"
              value={String(openAcknowledgements)}
            />
          </View>

          <ManagedConversationSection
            onOpen={(conversationId) => {
              workspace.selectConversation(conversationId);
              router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
            }}
          />

          {workspace.currentMembershipRole === 'owner' ? (
            <OrganizationPolicySection privilegedReady={privilegedReady} />
          ) : null}

          {workspace.hasCapability('ai.policy.manage') ? (
            <AiPolicySection
              onSignInAgain={() => {
                void (async () => {
                  // Sign-out revokes this session on the server; the local
                  // sign-out is the fallback when the revoke cannot be sent.
                  const revoked = auth.sessionId
                    ? await workspace.revokeSession(auth.sessionId, 'sign_out')
                    : false;
                  if (!revoked) await auth.signOut();
                  router.replace('/sign-in');
                })();
              }}
              privilegedReady={privilegedReady}
            />
          ) : null}

          {workspace.hasCapability('unit.manage') ? (
            <DynamicGroupSection privilegedReady={privilegedReady} />
          ) : null}

          {workspace.hasCapability('recovery.manage') ? (
            <AccountRecoverySection
              key={`recovery:${workspace.organizationId}:${currentUser.id}`}
              accessToken={auth.session?.access_token ?? null}
              assuranceLevel={auth.assuranceLevel}
              currentUserId={currentUser.id}
              onOpenSettings={() => router.push('/settings')}
              onVerifyNow={() => router.push('/settings')}
              organizationId={workspace.organizationId}
              people={workspace.people}
            />
          ) : null}

          {workspace.hasCapability('reports.investigate') || workspace.hasCapability('reports.assign') ? (
            <ModerationCaseSection
              key={`moderation:${workspace.organizationId}:${currentUser.id}`}
              accessToken={auth.session?.access_token ?? null}
              assuranceLevel={auth.assuranceLevel}
              currentUserId={currentUser.id}
              onVerifyNow={() => router.push('/settings')}
              organizationId={workspace.organizationId}
              people={workspace.people}
            />
          ) : null}

          {workspace.hasCapability('message.preservation.manage') ? (
            <MessagePreservationSection privilegedReady={privilegedReady} />
          ) : null}

          {workspace.hasCapability('language.review') ? (
            <AiQualityReviewSection
              privilegedReady={privilegedReady}
              onVerifyNow={() => router.push('/settings')}
            />
          ) : null}

          {workspace.hasCapability('audit.read') ? (
            <AuditAccessSection
              privilegedReady={privilegedReady}
              onVerifyNow={() => router.push('/settings')}
            />
          ) : null}

          <View style={styles.sectionTitleRow}>
            <View>
              <Text style={styles.sectionEyebrow}>{t('admin.accessControl')}</Text>
              <Text style={styles.sectionTitle}>{t('admin.visibleMembers')}</Text>
            </View>
            <PrimaryButton
              disabled={!privilegedReady || !workspace.hasCapability('invites.manage')}
              icon="person-add-outline"
              label={t('admin.inviteMember')}
              onPress={() => {
                workspace.clearActionError();
                setInviteDestinationType('email');
                setInviteDestination('');
                setInviteEmployeeCode('');
                setInviteActivationMode('otp');
                setInviteRole('member');
                setInviteExpiry(604800);
                setInviteMembershipType('employee');
                setInviteAccessDays(90);
                setInviteSponsorUserId(currentUser.id);
                setInviteSponsorCandidates([]);
                setInviteVisible(true);
                void workspace.queryGroupCreationCandidates('').then((candidates) => {
                  if (candidates) setInviteSponsorCandidates(candidates);
                });
              }}
              tone="dark"
            />
          </View>

          <View style={[styles.memberList, shadow]}>
            {workspace.people
              .filter((person) => person.id !== currentUser.id)
              .map((person) => (
                <View key={person.id} style={styles.memberRow}>
                  <Avatar color={person.avatarColor} initials={person.initials} size={44} />
                  <View style={styles.memberCopy}>
                    <Text style={styles.memberName}>{person.displayName}</Text>
                    <Text style={styles.memberMeta}>{person.roleLabel} · {person.site}</Text>
                  </View>
                  <View style={styles.memberActions}>
                    <PrimaryButton
                      disabled={!privilegedReady || !workspace.hasCapability('roles.read')}
                      icon="key-outline"
                      label={t('admin.manageRoles')}
                      onPress={() => openRoles(person.id)}
                      tone="light"
                    />
                    {person.suspended ? (
                      <StatusBadge icon="ban-outline" label={t('admin.suspended')} tone="danger" />
                    ) : (
                    <PrimaryButton
                      disabled={!privilegedReady || !workspace.hasCapability('members.security')}
                      icon="ban-outline"
                      label={t('admin.suspend')}
                      onPress={() => {
                        workspace.clearActionError();
                        setSuspendReason('');
                        setSuspendPersonId(person.id);
                      }}
                      tone="danger"
                    />
                    )}
                  </View>
                </View>
              ))}
          </View>
          <View style={styles.scopeNote}>
            <Ionicons name="information-circle-outline" size={17} color={colors.inkSubtle} />
            <Text style={styles.scopeNoteText}>
              {t('admin.scopeNote')}
            </Text>
          </View>
        </View>
      </ScrollView>

      <ActionModal
        description={t('admin.suspendDescription')}
        onClose={() => setSuspendPersonId('')}
        title={`${t('admin.suspendTitle')} ${suspendPerson?.displayName ?? t('admin.member')}`}
        visible={Boolean(suspendPerson)}>
        <FormField
          label={t('admin.reason')}
          multiline
          onChangeText={setSuspendReason}
          placeholder={t('admin.reasonPlaceholder')}
          value={suspendReason}
        />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!privilegedReady || !workspace.hasCapability('members.security') || suspendReason.trim().length < 3}
          icon="ban-outline"
          label={t('admin.suspendMember')}
          loading={workspace.actionBusy === 'member-suspend'}
          onPress={async () => {
            if (suspendPerson && await workspace.suspendMember(suspendPerson.id, suspendReason)) {
              setSuspendPersonId('');
            }
          }}
          tone="danger"
        />
      </ActionModal>

      <ActionModal
        description={t('admin.rolesDescription')}
        onClose={() => setRolePersonId('')}
        title={rolePerson ? `${t('admin.rolesTitle')} · ${rolePerson.displayName}` : t('admin.rolesTitle')}
        visible={Boolean(rolePerson)}>
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.role')}</Text>
          <View style={styles.roleChips}>
            {(Object.keys(roleLabels) as AdminRoleName[]).map((option) => (
              <Chip
                key={option}
                label={roleLabels[option]}
                onPress={() => setRoleName(option)}
                selected={roleName === option}
              />
            ))}
          </View>
        </View>
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.scope')}</Text>
          <View style={styles.roleChips}>
            <Chip label={t('admin.scopeOrganization')} onPress={() => setRoleScope('organization')} selected={roleScope === 'organization'} />
            <Chip label={t('admin.scopeUnit')} onPress={() => setRoleScope('unit')} selected={roleScope === 'unit'} />
          </View>
        </View>
        {roleScope === 'unit' ? (
          <FormField label={t('admin.unitId')} onChangeText={setRoleUnitId} placeholder={t('admin.unitIdPlaceholder')} value={roleUnitId} />
        ) : null}
        <FormField label={t('admin.expiresAt')} onChangeText={setRoleExpiresAt} value={roleExpiresAt} />
        <FormField label={t('admin.auditReason')} multiline onChangeText={setRoleReason} placeholder={t('admin.auditReasonPlaceholder')} value={roleReason} />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={
            !privilegedReady
            || !workspace.hasCapability('roles.manage')
            || roleReason.trim().length < 3
            || !roleExpirationValid
            || (roleScope === 'unit' && roleUnitId.trim().length < 8)
          }
          icon="key-outline"
          label={t('admin.assignRole')}
          loading={workspace.actionBusy === 'role-assign'}
          onPress={async () => {
            if (rolePerson && await workspace.assignRole(rolePerson.id, {
              roleName,
              scopeType: roleScope,
              unitId: roleScope === 'unit' ? roleUnitId.trim() : null,
              expiresAt: roleExpiresAt.trim() || null,
              reason: roleReason,
            })) {
              setRoleReason('');
            }
          }}
          tone="dark"
        />
        <View style={styles.roleListSection}>
          <Text style={styles.roleFormLabel}>{t('admin.existingRoles')}</Text>
          {workspace.actionBusy === 'roles-load' ? (
            <Text style={styles.roleEmpty}>{t('status.loading')}</Text>
          ) : workspace.roleAssignmentsPersonId === rolePersonId && workspace.roleAssignments.length ? (
            workspace.roleAssignments.map((assignment) => (
              <View key={assignment.assignmentId} style={styles.roleRow}>
                <View style={styles.roleRowCopy}>
                  <Text style={styles.roleRowTitle}>{roleLabels[assignment.roleName]}</Text>
                  <Text style={styles.roleRowMeta}>
                    {assignment.scopeType === 'organization' ? t('admin.scopeOrganization') : `${t('admin.scopeUnit')} · ${assignment.unitId}`}
                  </Text>
                  {assignment.expiresAt ? <Text style={styles.roleRowMeta}>{t('admin.expires')} · {assignment.expiresAt}</Text> : null}
                </View>
                <StatusBadge label={assignment.active ? t('admin.active') : t('admin.revoked')} tone={assignment.active ? 'success' : 'neutral'} />
                {assignment.active ? (
                  <PrimaryButton
                    disabled={!privilegedReady || !workspace.hasCapability('roles.manage')}
                    label={t('admin.revokeRole')}
                    onPress={() => {
                      setRevokeReason('');
                      setRevokeAssignmentId(assignment.assignmentId);
                    }}
                    tone="danger"
                  />
                ) : null}
              </View>
            ))
          ) : (
            <Text style={styles.roleEmpty}>{t('admin.noRoles')}</Text>
          )}
        </View>
      </ActionModal>

      <ActionModal
        description={t('admin.revokeRoleDescription')}
        onClose={() => setRevokeAssignmentId('')}
        title={t('admin.revokeRole')}
        visible={Boolean(revokeAssignmentId)}>
        <FormField
          label={t('admin.auditReason')}
          multiline
          onChangeText={setRevokeReason}
          placeholder={t('admin.auditReasonPlaceholder')}
          value={revokeReason}
        />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!privilegedReady || !workspace.hasCapability('roles.manage') || revokeReason.trim().length < 3}
          icon="close-circle-outline"
          label={t('admin.revokeRole')}
          loading={workspace.actionBusy === 'role-revoke'}
          onPress={async () => {
            if (await workspace.revokeRole(revokeAssignmentId, revokeReason)) {
              setRevokeAssignmentId('');
            }
          }}
          tone="danger"
        />
      </ActionModal>

      <ActionModal
        description={t('admin.inviteDescription')}
        onClose={() => {
          setInviteVisible(false);
          setInviteDestination('');
          setInviteEmployeeCode('');
        }}
        title={t('admin.inviteTitle')}
        visible={inviteVisible}>
        <View style={styles.inviteWarning}>
          <Ionicons name="mail-unread-outline" size={18} color={colors.amber} />
          <Text style={styles.inviteWarningText}>{t('admin.inviteManualDelivery')}</Text>
        </View>
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.inviteMembershipType')}</Text>
          <View style={styles.roleChips}>
            <Chip
              label={t('admin.inviteMembershipEmployee')}
              onPress={() => {
                setInviteMembershipType('employee');
                setInviteSponsorUserId('');
              }}
              selected={inviteMembershipType === 'employee'}
            />
            <Chip
              label={t('admin.inviteMembershipContractor')}
              onPress={() => {
                setInviteMembershipType('contractor');
                setInviteAccessDays(90);
                setInviteSponsorUserId('');
              }}
              selected={inviteMembershipType === 'contractor'}
            />
            <Chip
              label={t('admin.inviteMembershipGuest')}
              onPress={() => {
                setInviteMembershipType('guest');
                setInviteAccessDays(30);
                setInviteRole('member');
                setInviteSponsorUserId(currentUser.id);
              }}
              selected={inviteMembershipType === 'guest'}
            />
          </View>
          {inviteMembershipType === 'contractor' ? (
            <Text style={styles.roleEmpty}>{t('admin.inviteContractorDisclosure')}</Text>
          ) : null}
          {inviteMembershipType === 'guest' ? (
            <Text style={styles.roleEmpty}>{t('admin.inviteGuestDisclosure')}</Text>
          ) : null}
        </View>
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.inviteDestinationType')}</Text>
          <View style={styles.roleChips}>
            <Chip
              label={t('admin.inviteEmailChannel')}
              onPress={() => {
                setInviteDestinationType('email');
                setInviteDestination('');
              }}
              selected={inviteDestinationType === 'email'}
            />
            <Chip
              label={t('admin.invitePhoneChannel')}
              onPress={() => {
                setInviteDestinationType('phone');
                setInviteDestination('');
              }}
              selected={inviteDestinationType === 'phone'}
            />
          </View>
        </View>
        <FormField
          label={t(inviteDestinationType === 'email' ? 'admin.inviteEmail' : 'admin.invitePhone')}
          onChangeText={setInviteDestination}
          value={inviteDestination}
        />
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.inviteActivationMode')}</Text>
          <View style={styles.roleChips}>
            <Chip label={t('admin.inviteActivationOtp')} onPress={() => setInviteActivationMode('otp')} selected={inviteActivationMode === 'otp'} />
            <Chip label={t('admin.inviteActivationManual')} onPress={() => setInviteActivationMode('manual')} selected={inviteActivationMode === 'manual'} />
          </View>
          <Text style={styles.roleEmpty}>
            {inviteActivationMode === 'otp' ? t('admin.inviteActivationOtpBody') : t('admin.inviteActivationManualBody')}
          </Text>
        </View>
        {inviteActivationMode === 'manual' ? (
          <FormField
            label={t('admin.inviteEmployeeCode')}
            onChangeText={setInviteEmployeeCode}
            placeholder={t('auth.employeeCodePlaceholder')}
            value={inviteEmployeeCode}
          />
        ) : null}
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.inviteInitialRole')}</Text>
          <View style={styles.roleChips}>
            <Chip label={t('admin.inviteRoleMember')} onPress={() => setInviteRole('member')} selected={inviteRole === 'member'} />
            {inviteMembershipType !== 'guest' ? (
              <>
                <Chip label={t('admin.inviteRoleManager')} onPress={() => setInviteRole('manager')} selected={inviteRole === 'manager'} />
                <Chip label={t('admin.inviteRoleAdmin')} onPress={() => setInviteRole('admin')} selected={inviteRole === 'admin'} />
              </>
            ) : null}
          </View>
          {inviteMembershipType === 'guest' ? <Text style={styles.roleEmpty}>{t('admin.inviteGuestRoleLocked')}</Text> : null}
          {inviteRole === 'admin' ? <Text style={styles.roleEmpty}>{t('admin.inviteAdminOwnerOnly')}</Text> : null}
        </View>
        <View style={styles.roleFormSection}>
          <Text style={styles.roleFormLabel}>{t('admin.inviteExpiry')}</Text>
          <View style={styles.roleChips}>
            {([
              [3600, t('admin.inviteExpiryHour')],
              [86400, t('admin.inviteExpiryDay')],
              [604800, t('admin.inviteExpiryWeek')],
              [2592000, t('admin.inviteExpiryMonth')],
            ] as const).map(([seconds, label]) => (
              <Chip key={seconds} label={label} onPress={() => setInviteExpiry(seconds)} selected={inviteExpiry === seconds} />
            ))}
          </View>
        </View>
        {inviteMembershipType !== 'employee' ? (
          <View style={styles.roleFormSection}>
            <Text style={styles.roleFormLabel}>{t('admin.inviteAccessDuration')}</Text>
            <View style={styles.roleChips}>
              {([
                [30, t('admin.inviteAccess30Days')],
                [90, t('admin.inviteAccess90Days')],
                ...(inviteMembershipType === 'contractor'
                  ? [[365, t('admin.inviteAccess365Days')] as const]
                  : []),
              ] as const).map(([days, label]) => (
                <Chip
                  key={days}
                  label={label}
                  onPress={() => setInviteAccessDays(days)}
                  selected={inviteAccessDays === days}
                />
              ))}
            </View>
            {!inviteAccessDurationValid ? (
              <Text style={styles.validationText}>{t('admin.inviteAccessAfterInvite')}</Text>
            ) : null}
          </View>
        ) : null}
        {inviteMembershipType === 'guest' ? (
          <View style={styles.roleFormSection}>
            <Text style={styles.roleFormLabel}>{t('admin.inviteSponsor')}</Text>
            <View style={styles.roleChips}>
              {inviteSponsorOptions.map((candidate) => (
                <Chip
                  key={candidate.userId}
                  label={candidate.displayName}
                  onPress={() => setInviteSponsorUserId(candidate.userId)}
                  selected={inviteSponsorUserId === candidate.userId}
                />
              ))}
            </View>
            <Text style={styles.roleEmpty}>{t('admin.inviteSponsorDisclosure')}</Text>
          </View>
        ) : null}
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={
            !privilegedReady
            || !workspace.hasCapability('invites.manage')
            || !inviteDestinationValid
            || !inviteEmployeeCodeValid
            || !inviteAccessDurationValid
            || (inviteMembershipType === 'guest' && !inviteSponsorUserId)
          }
          icon="key-outline"
          label={t('admin.createInvite')}
          loading={workspace.actionBusy === 'invite-issue'}
          onPress={async () => {
            const invitation = await workspace.issueInvitation({
              destinationType: inviteDestinationType,
              destination: normalizedInviteDestination,
              activationMode: inviteActivationMode,
              employeeCode: inviteActivationMode === 'manual' ? inviteEmployeeCode : null,
              role: inviteMembershipType === 'guest' ? 'member' : inviteRole,
              expiresInSeconds: inviteExpiry,
              membershipType: inviteMembershipType,
              membershipAccessExpiresAt: inviteMembershipType === 'employee'
                ? null
                : new Date(Date.now() + inviteAccessDays * 24 * 60 * 60 * 1000).toISOString(),
              guestSponsorUserId: inviteMembershipType === 'guest' ? inviteSponsorUserId : null,
            });
            if (invitation) {
              setInviteVisible(false);
              setInviteDestination('');
              setInviteEmployeeCode('');
              setInviteCopied(false);
              setIssuedInvitation(invitation);
            }
          }}
          tone="dark"
        />
      </ActionModal>

      <ActionModal
        description={t('admin.inviteOneTimeDescription')}
        onClose={closeIssuedInvitation}
        title={t('admin.inviteOneTimeTitle')}
        visible={Boolean(issuedInvitation)}>
        {issuedInvitation ? (
          <>
            <View style={styles.inviteWarning}>
              <Ionicons name="warning-outline" size={18} color={colors.amber} />
              <Text style={styles.inviteWarningText}>{t('admin.inviteCopyWarning')}</Text>
            </View>
            <Text style={styles.inviteReceiptMeta}>{issuedInvitation.destinationMasked} · {issuedInvitation.role}</Text>
            <Text style={styles.inviteReceiptMeta}>
              {t('admin.inviteMembershipType')} · {t(
                issuedInvitation.membershipType === 'employee'
                  ? 'admin.inviteMembershipEmployee'
                  : issuedInvitation.membershipType === 'contractor'
                  ? 'admin.inviteMembershipContractor'
                  : 'admin.inviteMembershipGuest'
              )}
            </Text>
            <Text style={styles.inviteReceiptMeta}>{t('admin.inviteActivationMode')} · {issuedInvitation.activationMode}</Text>
            <Text style={styles.inviteReceiptMeta}>{t('admin.expires')} · {issuedInvitation.expiresAt}</Text>
            {issuedInvitation.membershipAccessExpiresAt ? (
              <Text style={styles.inviteReceiptMeta}>
                {t('admin.inviteAccessExpiry')} · {issuedInvitation.membershipAccessExpiresAt}
              </Text>
            ) : null}
            {issuedGuestSponsorName ? (
              <Text style={styles.inviteReceiptMeta}>
                {t('admin.inviteSponsor')} · {issuedGuestSponsorName}
              </Text>
            ) : null}
            {issuedInvitation.activationToken ? (
              <Text selectable style={styles.activationUrl}>{issuedInvitation.activationToken}</Text>
            ) : (
              <Text style={styles.inviteUnavailable}>
                {issuedInvitation.activationMode === 'otp'
                  ? t('admin.inviteOtpDeliveryReceipt')
                  : t('admin.inviteUnavailable')}
              </Text>
            )}
            <PrimaryButton
              disabled={!issuedInvitation.activationToken}
              icon={inviteCopied ? 'checkmark-outline' : 'copy-outline'}
              label={inviteCopied ? t('admin.inviteCopied') : t('admin.inviteCopy')}
              onPress={async () => {
                if (!issuedInvitation.activationToken) return;
                await Clipboard.setStringAsync(issuedInvitation.activationToken);
                setInviteCopied(true);
              }}
              tone="dark"
            />
            <PrimaryButton label={t('admin.inviteDone')} onPress={closeIssuedInvitation} tone="light" />
          </>
        ) : null}
      </ActionModal>
    </AppScaffold>
  );
}

function MetricCard({
  icon,
  label,
  value,
  note,
  tone = 'neutral',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  note: string;
  tone?: 'neutral' | 'danger';
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={[styles.metricCard, shadow]}>
      <View style={[styles.metricIcon, tone === 'danger' && styles.metricIconDanger]}>
        <Ionicons name={icon} size={18} color={tone === 'danger' ? colors.red : colors.mintDark} />
      </View>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricNote, tone === 'danger' && styles.metricNoteDanger]}>{note}</Text>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  deniedPage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  deniedIcon: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: radii.lg, backgroundColor: colors.amberSoft },
  deniedTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: spacing.md },
  deniedText: { maxWidth: 440, color: colors.inkSubtle, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: spacing.xs },
  page: { flexGrow: 1, paddingBottom: spacing.xxxl },
  pageMobile: { padding: spacing.md, paddingBottom: 100 },
  content: { width: '100%', maxWidth: 1140, alignSelf: 'center' },
  contentDesktop: { paddingHorizontal: spacing.xxl },
  securityBanner: { padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radii.lg, backgroundColor: colors.mintSoft, borderWidth: 1, borderColor: colors.mintBorder },
  securityBannerIcon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.paper },
  securityBannerCopy: { flex: 1, minWidth: 0 },
  securityBannerActions: { alignItems: 'flex-end', gap: spacing.xs },
  securityBannerTitle: { color: colors.accentInk, fontSize: 14, fontWeight: '900' },
  securityBannerText: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  metricCard: { minWidth: 210, flex: 1, minHeight: 138, padding: spacing.md, borderRadius: radii.lg, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  metricIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm, backgroundColor: colors.mintSoft },
  metricIconDanger: { backgroundColor: colors.redSoft },
  metricValue: { color: colors.ink, fontFamily: type.display, fontSize: 23, fontWeight: '900', marginTop: spacing.sm },
  metricLabel: { color: colors.inkMuted, fontSize: 11, fontWeight: '800', marginTop: 2 },
  metricNote: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14, marginTop: 5 },
  metricNoteDanger: { color: colors.red },
  adminDataSection: { width: '100%' },
  adminDataList: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  adminDataRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  adminDataIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.paperMuted },
  adminDataCopy: { flex: 1, minWidth: 0 },
  adminDataTitle: { color: colors.ink, fontSize: 12, fontWeight: '900', textTransform: 'capitalize' },
  adminDataMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 3 },
  adminDataExcerpt: { color: colors.inkMuted, fontSize: 10, lineHeight: 15, marginTop: 4 },
  adminDataEmpty: { color: colors.inkSubtle, fontSize: 11, padding: spacing.lg, textAlign: 'center' },
  sectionTitleRow: { minHeight: 90, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingTop: spacing.xl, paddingBottom: spacing.md },
  sectionEyebrow: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  sectionTitle: { color: colors.ink, fontFamily: type.display, fontSize: 21, fontWeight: '800', marginTop: 3 },
  memberList: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  memberRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  memberCopy: { flex: 1, minWidth: 0 },
  memberName: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  memberMeta: { color: colors.inkSubtle, fontSize: 10, marginTop: 3 },
  memberActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs },
  scopeNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.md, marginTop: spacing.md, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  scopeNoteText: { flex: 1, color: colors.inkSubtle, fontSize: 10, lineHeight: 16 },
  roleFormSection: { gap: spacing.xs },
  roleFormLabel: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  roleChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  roleListSection: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  roleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  roleRowCopy: { flex: 1, minWidth: 180 },
  roleRowTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  roleRowMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 2 },
  roleEmpty: { color: colors.inkSubtle, fontSize: 10, lineHeight: 16 },
  validationText: { color: colors.red, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  inviteWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.amberSoft },
  inviteWarningText: { flex: 1, color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  inviteReceiptMeta: { color: colors.inkMuted, fontSize: 10, fontWeight: '800' },
  activationUrl: { padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.forest, color: colors.white, fontSize: 10, lineHeight: 16 },
  inviteUnavailable: { padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.redSoft, color: colors.red, fontSize: 10, lineHeight: 16 },
});
