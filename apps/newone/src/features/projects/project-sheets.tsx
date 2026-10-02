import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal } from '@/components/ui/action-modal';
import { PrimaryButton } from '@/components/ui/primitives';
import type { ProjectItemTarget } from '@/data/repositories/contracts';
import type { Conversation } from '@/domain/types';
import { ProjectsPanel } from '@/features/projects/projects-panel';
import { showProject, useProjectView } from '@/features/projects/project-view';
import { useConversationProjects } from '@/features/projects/use-conversation-projects';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/** The chat's projects in a sheet: the phone's way in, and the header button's on the web. */
export function ProjectsSheet({
  conversation,
  visible,
  onClose,
}: {
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <ActionModal onClose={onClose} title={t('projects.title')} visible={visible}>
      <ProjectsPanel conversation={conversation} onProjectOpened={onClose} />
    </ActionModal>
  );
}

/**
 * Above the composer while this reader is filing into a project, so nobody
 * wonders where their message went: "Saving to 3. Transportation", or, while
 * the chat shows only that project's conversation, "Only 3. Transportation".
 * One button switches between the project's conversation and the whole chat;
 * the ✕ stops saving (and shows the whole chat again).
 */
export function ActiveProjectBar({
  conversation,
  onOpenProjects,
}: {
  conversation: Conversation;
  onOpenProjects: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const { projects, selectedProject, run } = useConversationProjects(conversation.id);
  const view = useProjectView(conversation.id);
  if (!selectedProject || !projects) return null;
  const name = `${projects.projects.indexOf(selectedProject) + 1}. ${selectedProject.name}`;
  const viewing = view?.projectId === selectedProject.id;
  const label = t(viewing ? 'projects.viewing' : 'projects.activeBar').replace('{name}', name);
  return (
    <View accessibilityLiveRegion="polite" style={[styles.bar, viewing && styles.barViewing]} testID="active-project-bar">
      <Pressable
        accessibilityHint={t('projects.activeHint')}
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onOpenProjects}
        style={({ pressed }) => [styles.barMain, pressed && styles.pressed]}>
        <Ionicons color={colors.mintDark} name={viewing ? 'filter' : 'folder-open'} size={15} />
        <Text numberOfLines={1} style={styles.barText}>{label}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={viewing ? t('projects.showAll') : t('projects.showOnly')}
        accessibilityRole="button"
        hitSlop={6}
        onPress={() => showProject(conversation.id, viewing ? null : selectedProject.id)}
        style={({ pressed }) => [styles.barToggle, pressed && styles.pressed]}
        testID="project-view-toggle">
        <Text style={styles.barToggleText}>{viewing ? t('projects.showAll') : t('projects.showOnly')}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={t('projects.stopUsing')}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => void run({ action: 'select', projectId: null }).then((result) => {
          if (result) showProject(conversation.id, null);
        })}
        style={({ pressed }) => [styles.barClose, pressed && styles.pressed]}>
        <Ionicons color={colors.inkMuted} name="close" size={16} />
      </Pressable>
    </View>
  );
}

/**
 * Files, links and summaries from before a project existed go in by hand:
 * pick the project and it is saved there.
 */
export function SaveToProjectSheet({
  conversation,
  target,
  onClose,
  onSaved,
}: {
  conversation: Conversation;
  /** Null keeps the sheet closed. */
  target: ProjectItemTarget | null;
  onClose: () => void;
  onSaved?: (projectName: string) => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const { projects, run } = useConversationProjects(target ? conversation.id : null);
  const list = projects?.projects ?? [];
  return (
    <ActionModal onClose={onClose} title={t('projects.chooseProject')} visible={Boolean(target)}>
      {list.length === 0 ? <Text style={styles.empty}>{t('projects.empty')}</Text> : null}
      <View style={styles.choices}>
        {list.map((project, index) => (
          <PrimaryButton
            icon="folder-outline"
            key={project.id}
            label={`${index + 1}. ${project.name}`}
            loading={workspace.actionBusy === 'project:add_item'}
            onPress={async () => {
              if (!target) return;
              if (await run({ action: 'add_item', projectId: project.id, target })) {
                onSaved?.(project.name);
                onClose();
              }
            }}
            tone="light"
          />
        ))}
      </View>
      <ActionError message={workspace.actionError} />
    </ActionModal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.sm,
    marginTop: spacing.xs,
    paddingLeft: spacing.sm,
    paddingRight: 4,
    minHeight: 34,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  barViewing: { borderWidth: 1, borderColor: colors.mintDark },
  barMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34 },
  barText: { flexShrink: 1, color: colors.accentInk, fontSize: 12, fontWeight: '800' },
  barToggle: {
    minHeight: 26,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: colors.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.mintDark,
  },
  barToggleText: { color: colors.mintDark, fontSize: 11, fontWeight: '800' },
  barClose: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  choices: { gap: spacing.xs },
  empty: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.6 },
});
