import { useRouter } from 'expo-router';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { Conversation, Person } from '@/domain/types';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, spacing, type } from '@/theme/tokens';

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
      const displayName = person?.displayName ?? profile?.displayName ?? '';
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
  }, [currentUserId, memberIds, memberProfiles, memberRoles, people]);

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
        const open = openMemberId === member.userId;
        const muted = member.person?.mutedByMe === true;
        const blocked = member.person?.blockedByMe === true;
        const connectionState = member.person?.connectionState;
        return (
          <View key={member.userId} style={styles.row}>
            <View style={styles.rowMain}>
              <Avatar color={member.avatarColor} initials={member.initials} size={34} />
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
                  name={open ? 'chevron-up' : 'ellipsis-horizontal'}
                  onPress={() => setOpenMemberId(open ? null : member.userId)}
                  size={32}
                />
              )}
            </View>
            {open ? (
              <View style={styles.actions}>
                <PrimaryButton
                  label={t('group.memberMessage')}
                  onPress={async () => {
                    const conversationId = await workspace.openOrCreateDirectConversation(member.userId);
                    if (conversationId) openConversation(conversationId);
                  }}
                  tone="light"
                />
                {connectionState === 'connected' || connectionState === 'self' ? null : (
                  <PrimaryButton
                    disabled={connectionState === 'pending'}
                    label={t(connectionState === 'pending' ? 'group.memberRequested' : 'group.memberAddFriend')}
                    onPress={() => void workspace.updateConnection(member.userId)}
                    tone="light"
                  />
                )}
                <PrimaryButton
                  label={t(muted ? 'group.memberUnmute' : 'group.memberMute')}
                  onPress={() => void workspace.setPersonMuted(member.userId, !muted)}
                  tone="light"
                />
                <PrimaryButton
                  label={t(blocked ? 'group.memberUnblock' : 'group.memberBlock')}
                  onPress={() => void workspace.setPersonBlocked(member.userId, !blocked)}
                  tone={blocked ? 'light' : 'danger'}
                />
                {canManage ? (
                  <PrimaryButton
                    label={t('group.memberRemove')}
                    onPress={async () => {
                      if (await workspace.removeConversationMember(conversation.id, member.userId)) {
                        setOpenMemberId(null);
                      }
                    }}
                    tone="danger"
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export default GroupMembersSection;

const styles = StyleSheet.create({
  section: { gap: spacing.xs },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 14, fontWeight: '900' },
  empty: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  row: {
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowMain: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.inkSubtle, fontSize: 11 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingLeft: 42,
    paddingBottom: spacing.xs,
    borderRadius: radii.md,
  },
});
