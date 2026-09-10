import { useRouter } from 'expo-router';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionModal } from '@/components/ui/action-modal';
import { Avatar, Chip, IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { Conversation, Person } from '@/domain/types';
import { personDisplayName } from '@/domain/person-name';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/** One row's worth of a member, resolved from the roster and the directory. */
interface GroupMember {
  userId: string;
  displayName: string;
  username: string | null;
  initials: string;
  avatarColor: string;
  role: 'owner' | 'admin' | 'member';
  isSelf: boolean;
  person: Person | null;
}

export interface GroupMembersSectionProps {
  conversation: Conversation;
  /**
   * Where a "Message" tap lands. Defaults to opening the direct chat on this
   * device; a host that keeps its own layout can send it somewhere else.
   */
  onOpenConversation?: (conversationId: string) => void;
}

function initialsOf(displayName: string): string {
  return displayName.trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0] ?? '').join('').toUpperCase() || '?';
}

/**
 * The people in a group, each row one line: avatar, name, @handle and a single
 * control that opens what you can do about them. Mount it inside conversation
 * settings for a group; it renders nothing for a one-to-one chat.
 */
export function GroupMembersSection({ conversation, onOpenConversation }: GroupMembersSectionProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const router = useRouter();
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const currentUserId = workspace.currentUser?.id ?? '';
  const people = workspace.people;
  const memberIds = conversation.memberIds;
  const memberRoles = conversation.memberRoles;
  const memberProfiles = conversation.memberProfiles;

  const members = useMemo<GroupMember[]>(() => {
    const byId = new Map(people.map((person) => [person.id, person]));
    return (memberIds ?? []).map((userId) => {
      const person = byId.get(userId) ?? null;
      const profile = memberProfiles?.find((entry) => entry.id === userId) ?? null;
      const displayName = person ? personDisplayName(person) : profile?.displayName ?? '';
      return {
        userId,
        displayName,
        username: person?.username ?? null,
        initials: person?.initials ?? profile?.initials ?? initialsOf(displayName),
        avatarColor: person?.avatarColor ?? profile?.avatarColor ?? colors.forest,
        role: memberRoles?.[userId] ?? profile?.role ?? 'member',
        isSelf: userId === currentUserId,
        person,
      };
    }).filter((member) => member.displayName.length > 0);
  }, [colors.forest, currentUserId, memberIds, memberProfiles, memberRoles, people]);

  if (conversation.kind === 'direct') return null;
  // A management-only view belongs to someone who manages the group without
  // being in it; the workplace realm has its own member controls above.
  if (conversation.managementOnly) return null;
  if (!isPersonalRealm(workspace.organizationId)) return null;

  const canManage = conversation.myRole === 'owner' || conversation.myRole === 'admin';
  const openConversation = (conversationId: string) => {
    if (onOpenConversation) onOpenConversation(conversationId);
    else router.replace({ pathname: '/conversation/[id]', params: { id: conversationId } });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('group.membersTitle')}</Text>
      {members.length === 0 ? (
        <Text style={styles.empty}>{t('group.membersEmpty')}</Text>
      ) : members.map((member) => {
        const muted = member.person?.mutedByMe === true;
        const blocked = member.person?.blockedByMe === true;
        return (
          <View key={member.userId} style={styles.row}>
            <View style={styles.rowMain}>
              <Avatar color={member.avatarColor} initials={member.initials} size={30} />
              <View style={styles.rowCopy}>
                <View style={styles.rowTitle}>
                  <Text numberOfLines={1} style={styles.name}>
                    {member.isSelf ? `${member.displayName} · ${t('group.memberYou')}` : member.displayName}
                  </Text>
                  {member.role === 'member' ? null : (
                    <StatusBadge
                      label={t(member.role === 'owner' ? 'group.owner' : 'group.admin')}
                      tone="neutral"
                    />
                  )}
                </View>
                <Text numberOfLines={1} style={styles.meta}>
                  {[
                    member.username ? `@${member.username}` : null,
                    muted ? t('group.memberMuted') : null,
                    blocked ? t('group.memberBlocked') : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {member.isSelf ? null : (
                <IconButton
                  label={`${t('group.memberActions')} ${member.displayName}`}
                  name="ellipsis-horizontal"
                  onPress={() => setOpenMemberId(member.userId)}
                  size={32}
                />
              )}
            </View>
          </View>
        );
      })}
      <MemberSheet
        canManage={canManage}
        conversation={conversation}
        member={members.find((item) => item.userId === openMemberId) ?? null}
        onClose={() => setOpenMemberId(null)}
        onOpenConversation={openConversation}
      />
    </View>
  );
}

/**
 * Everything you can do about one person in a group, in one sheet: message
 * them, add them, mute them, block them, change their role and remove them.
 * Until v3.4 the roles lived in one list and the rest in another, and the
 * second one was drawn inside a scrolling sheet where the buttons could fall
 * below the fold and take the sheet down with them when tapped.
 */
function MemberSheet({
  canManage,
  conversation,
  member,
  onClose,
  onOpenConversation,
}: {
  canManage: boolean;
  conversation: Conversation;
  member: GroupMember | null;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const router = useRouter();
  if (!member) return null;
  const muted = member.person?.mutedByMe === true;
  const blocked = member.person?.blockedByMe === true;
  const connectionState = member.person?.connectionState;
  const roles: Array<'owner' | 'admin' | 'member'> = ['owner', 'admin', 'member'];
  return (
    <ActionModal
      onClose={onClose}
      title={member.displayName}
      visible>
      {member.username ? <Text style={styles.sheetHandle}>@{member.username}</Text> : null}
      <PrimaryButton
        accessibilityLabel={`${t('group.memberMessage')} ${member.displayName}`}
        label={t('group.memberMessage')}
        onPress={async () => {
          const conversationId = await workspace.openOrCreateDirectConversation(member.userId);
          onClose();
          if (conversationId) onOpenConversation(conversationId);
        }}
        tone="light"
      />
      {connectionState === 'connected' || connectionState === 'self' ? null : (
        <PrimaryButton
          disabled={connectionState === 'pending'}
          accessibilityLabel={`${t(connectionState === 'pending' ? 'group.memberRequested' : 'group.memberAddFriend')} ${member.displayName}`}
          label={t(connectionState === 'pending' ? 'group.memberRequested' : 'group.memberAddFriend')}
          onPress={() => void workspace.updateConnection(member.userId)}
          tone="light"
        />
      )}
      <PrimaryButton
        accessibilityLabel={`${t(muted ? 'group.memberUnmute' : 'group.memberMute')} ${member.displayName}`}
        label={t(muted ? 'group.memberUnmute' : 'group.memberMute')}
        onPress={() => void workspace.setPersonMuted(member.userId, !muted)}
        tone="light"
      />
      <PrimaryButton
        accessibilityLabel={`${t(blocked ? 'group.memberUnblock' : 'group.memberBlock')} ${member.displayName}`}
        label={t(blocked ? 'group.memberUnblock' : 'group.memberBlock')}
        onPress={() => void workspace.setPersonBlocked(member.userId, !blocked)}
        tone={blocked ? 'light' : 'danger'}
      />
      {/* Reporting has to be reachable from the conversation the person is in,
          not only from Contacts. The form itself stays in one place: this opens
          Contacts on that person with it up, rather than the chat carrying a
          second copy of a category picker, a details field and a consent
          notice. */}
      <PrimaryButton
        accessibilityLabel={`${t('group.memberReport')} ${member.displayName}`}
        label={t('group.memberReport')}
        onPress={() => {
          onClose();
          router.push({ pathname: '/people', params: { report: member.userId } });
        }}
        tone="light"
      />
      {canManage && !conversation.policyManaged ? (
        <>
          <Text style={styles.sheetLabel}>{t('group.memberRoleLabel')}</Text>
          <View style={styles.sheetRoles}>
            {roles.map((role) => (
              <Chip
                accessibilityLabel={`${t(`chat.${role}Role`)} · ${member.displayName}`}
                key={role}
                label={t(`chat.${role}Role`)}
                onPress={member.role === role ? undefined : () => void workspace.updateConversationMemberRole(
                  conversation.id, member.userId, member.role, role,
                )}
                selected={member.role === role}
              />
            ))}
          </View>
          <PrimaryButton
            accessibilityLabel={`${t('group.memberRemove')} ${member.displayName}`}
            label={t('group.memberRemove')}
            onPress={async () => {
              if (await workspace.removeConversationMember(conversation.id, member.userId)) onClose();
            }}
            tone="danger"
          />
        </>
      ) : null}
    </ActionModal>
  );
}

export default GroupMembersSection;

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  section: { gap: spacing.xs },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 14, fontWeight: '900' },
  empty: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  row: {
    gap: 2,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowMain: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.inkSubtle, fontSize: 11 },
  sheetHandle: { color: colors.inkSubtle, fontSize: 12 },
  sheetLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  sheetRoles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingLeft: 42,
    paddingBottom: spacing.xs,
    borderRadius: radii.md,
  },
});
