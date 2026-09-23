import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { IconButton, PrimaryButton } from '@/components/ui/primitives';
import type {
  ConversationProject,
  ConversationProjects,
  ProjectItem,
  ProjectItemKind,
} from '@/data/repositories/contracts';
import type { Conversation } from '@/domain/types';
import { copyImage } from '@/features/chat/copy-image';
import { ImageViewerModal } from '@/features/chat/image-viewer';
import { mediaSizeLabel } from '@/features/chat/shared-media';
// Metro selects the platform adapter (share sheet natively, a download on web).
// eslint-disable-next-line import/no-unresolved
import { saveSummaryFile } from '@/features/chat/summary-export';
import {
  linkLabel,
  projectItemLabel,
  projectItems,
  projectNameTaken,
  projectSummaryFileName,
} from '@/features/projects/project-names';
import { useConversationProjects } from '@/features/projects/use-conversation-projects';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

type IconName = ComponentProps<typeof Ionicons>['name'];

const DRAWERS: { kind: ProjectItemKind; labelKey: MessageKey; icon: IconName }[] = [
  { kind: 'summary', labelKey: 'projects.drawerSummaries', icon: 'document-text-outline' },
  { kind: 'upload', labelKey: 'projects.drawerUploads', icon: 'cloud-upload-outline' },
  { kind: 'link', labelKey: 'projects.drawerLinks', icon: 'link-outline' },
];

/**
 * On the web a right-click opens the same menu a long press opens on a phone
 * (owner's father, Sep 23 2026: right-click "Projects" to make one). The
 * listener sits on the element's own DOM node and stops there, so the chat
 * row the tree hangs from never sees it.
 */
function useContextMenu(open: (() => void) | undefined) {
  const ref = useRef<View>(null);
  useEffect(() => {
    const node = ref.current as unknown as {
      addEventListener?: (type: string, listener: (event: Event) => void) => void;
      removeEventListener?: (type: string, listener: (event: Event) => void) => void;
    } | null;
    if (Platform.OS !== 'web' || !open || !node?.addEventListener) return undefined;
    const handler = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    };
    node.addEventListener('contextmenu', handler);
    return () => node.removeEventListener?.('contextmenu', handler);
  }, [open]);
  return ref;
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'rename'; project: ConversationProject }
  | { kind: 'options'; project: ConversationProject }
  | { kind: 'delete'; project: ConversationProject }
  | { kind: 'item'; item: ProjectItem }
  | { kind: 'renameItem'; item: ProjectItem }
  | null;

/**
 * A chat's projects as the owner's father drew them (Sep 23 2026): numbered
 * projects, each with three drawers (the summaries saved into it, the files
 * and photos people sent, and the links they shared), everything in them
 * ready to take out again. Everyone in the chat sees the same projects; the
 * one marked "Saving here" is where this reader's own files, links and
 * summaries go.
 */
export function ProjectsPanel({
  conversation,
  variant = 'sheet',
}: {
  conversation: Conversation;
  /** The sidebar hangs the tree under the open chat's row; the sheet is the phone's (and the header button's) view. */
  variant?: 'sheet' | 'sidebar';
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const { projects, run } = useConversationProjects(conversation.id);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ProjectItem | null>(null);
  // The sidebar tree folds to its one header line when the reader wants the
  // list back; the sheet always shows everything.
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = variant === 'sidebar';
  const headerRef = useContextMenu(() => openCreate());

  const isOpen = (key: string, fallback: boolean) => expanded[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? fallback) }));

  function openCreate() {
    workspace.clearActionError();
    setName('');
    setNameError(null);
    setDialog({ kind: 'create' });
  }

  const busy = workspace.actionBusy?.startsWith('project:') ?? false;
  const close = () => {
    setDialog(null);
    setNameError(null);
  };

  const submitName = async () => {
    if (!dialog) return;
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    if (dialog.kind === 'create' || dialog.kind === 'rename') {
      if (projectNameTaken(projects, trimmed, dialog.kind === 'rename' ? dialog.project.id : undefined)) {
        setNameError(t('projects.nameTaken'));
        return;
      }
      const result = dialog.kind === 'create'
        ? await run({ action: 'create', name: trimmed })
        : await run({ action: 'rename', projectId: dialog.project.id, name: trimmed });
      if (result) {
        if (result.projectId) setExpanded((current) => ({ ...current, [result.projectId as string]: true }));
        close();
      }
      return;
    }
    if (dialog.kind === 'renameItem') {
      if (await run({ action: 'rename_item', itemId: dialog.item.id, name: trimmed })) close();
    }
  };

  const download = async (item: ProjectItem, format: 'pdf' | 'docx') => {
    if (!item.summary) return;
    const file = await workspace.exportSummaryFile(conversation.id, item.summary.summaryId, format);
    if (!file) return;
    await saveSummaryFile({
      fileName: projectSummaryFileName(item, format),
      title: projectItemLabel(item),
      bytes: file.bytes,
      mimeType: file.contentType,
    }).catch(() => undefined);
  };

  const openItem = (item: ProjectItem) => {
    if (item.link) {
      void Linking.openURL(item.link.url);
      return;
    }
    if (item.upload?.mediaKind === 'image' && item.upload.previewUrl) {
      setViewing(item);
      return;
    }
    if (item.upload) void workspace.downloadAttachmentById(conversation.id, item.upload.attachmentId);
  };

  const list = projects?.projects ?? [];
  // The tree opens the way it was drawn (owner's father, Sep 23 2026): the
  // project being saved into, and in a chat with a few projects every one
  // that holds something; a longer list stays folded to its names.
  const openByDefault = (projectId: string) => projectId === projects?.selectedProjectId
    || (list.length <= 3 && Boolean(projects?.items.some((item) => item.projectId === projectId)));
  return (
    <View style={[styles.panel, variant === 'sidebar' && styles.panelSidebar]} testID="projects-panel">
      <View ref={headerRef} style={styles.headerRow}>
        <Pressable
          accessibilityLabel={`${t('projects.title')} ${list.length}`}
          accessibilityRole={sidebar ? 'button' : 'header'}
          accessibilityState={sidebar ? { expanded: !collapsed } : undefined}
          disabled={!sidebar}
          onPress={() => setCollapsed((current) => !current)}
          style={styles.headerTitleRow}
          testID="projects-header">
          {sidebar ? (
            <Ionicons color={colors.inkSubtle} name={collapsed ? 'chevron-forward' : 'chevron-down'} size={14} />
          ) : null}
          <Ionicons color={colors.mintDark} name="folder-open-outline" size={17} />
          <Text style={styles.headerTitle}>{t('projects.title')}</Text>
          {list.length ? <Text style={styles.headerCount}>{list.length}</Text> : null}
        </Pressable>
        <View style={styles.spacer} />
        <IconButton label={t('projects.new')} name="add" onPress={openCreate} size={30} tone="accent" />
      </View>

      {sidebar && collapsed ? null : !projects ? (
        <ActivityIndicator color={colors.mintDark} style={styles.loading} />
      ) : list.length === 0 ? (
        sidebar ? null : <Text style={styles.empty}>{t('projects.empty')}</Text>
      ) : (
        list.map((project, index) => (
          <ProjectBranch
            drawersOpen={(kind) => isOpen(`${project.id}:${kind}`, projectItems(projects, project.id, kind).length > 0)}
            index={index}
            key={project.id}
            onDownload={download}
            onItemOptions={(item) => {
              workspace.clearActionError();
              setDialog({ kind: 'item', item });
            }}
            onOpenItem={openItem}
            onOptions={() => {
              workspace.clearActionError();
              setDialog({ kind: 'options', project });
            }}
            onSelect={() => void run({
              action: 'select',
              projectId: projects.selectedProjectId === project.id ? null : project.id,
            })}
            onToggle={() => toggle(project.id, openByDefault(project.id))}
            onToggleDrawer={(kind) =>
              toggle(`${project.id}:${kind}`, projectItems(projects, project.id, kind).length > 0)}
            open={isOpen(project.id, openByDefault(project.id))}
            project={project}
            projects={projects}
            selected={project.id === projects.selectedProjectId}
          />
        ))
      )}

      <ActionModal
        onClose={close}
        title={dialog?.kind === 'rename'
          ? t('projects.renameTitle')
          : dialog?.kind === 'renameItem'
            ? t('projects.renameFile')
            : t('projects.newTitle')}
        visible={dialog?.kind === 'create' || dialog?.kind === 'rename' || dialog?.kind === 'renameItem'}>
        <FormField
          label={dialog?.kind === 'renameItem' ? t('projects.fileName') : t('projects.nameLabel')}
          onChangeText={(value) => {
            setName(value);
            setNameError(null);
          }}
          onSubmitEditing={() => void submitName()}
          placeholder={dialog?.kind === 'renameItem' ? undefined : t('projects.namePlaceholder')}
          testID="project-name-input"
          value={name}
        />
        {dialog?.kind === 'renameItem' && dialog.item.kind === 'summary' ? (
          <Text style={styles.hint}>{t('projects.fileNameHint')}</Text>
        ) : null}
        <ActionError message={nameError ?? workspace.actionError} />
        <PrimaryButton
          disabled={!name.trim() || name.trim().length > (dialog?.kind === 'renameItem' ? 120 : 60)}
          label={dialog?.kind === 'create' ? t('projects.create') : t('projects.save')}
          loading={busy}
          onPress={() => void submitName()}
          testID="project-name-save"
          tone="dark"
        />
      </ActionModal>

      <ActionModal
        onClose={close}
        title={dialog?.kind === 'options' ? `${list.indexOf(dialog.project) + 1}. ${dialog.project.name}` : ''}
        visible={dialog?.kind === 'options'}>
        {dialog?.kind === 'options' ? (
          <View style={styles.menu}>
            <PrimaryButton
              icon={projects?.selectedProjectId === dialog.project.id ? 'close-circle-outline' : 'checkmark-circle-outline'}
              label={projects?.selectedProjectId === dialog.project.id ? t('projects.stopUsing') : t('projects.use')}
              loading={workspace.actionBusy === 'project:select'}
              onPress={async () => {
                const next = projects?.selectedProjectId === dialog.project.id ? null : dialog.project.id;
                if (await run({ action: 'select', projectId: next })) close();
              }}
              tone="light"
            />
            <PrimaryButton
              icon="create-outline"
              label={t('projects.rename')}
              onPress={() => {
                setName(dialog.project.name);
                setNameError(null);
                setDialog({ kind: 'rename', project: dialog.project });
              }}
              tone="light"
            />
            <PrimaryButton
              icon="trash-outline"
              label={t('projects.delete')}
              onPress={() => setDialog({ kind: 'delete', project: dialog.project })}
              tone="danger"
            />
            <ActionError message={workspace.actionError} />
          </View>
        ) : null}
      </ActionModal>

      <ActionModal
        description={t('projects.deleteBody')}
        onClose={close}
        title={dialog?.kind === 'delete' ? t('projects.deleteTitle').replace('{name}', dialog.project.name) : ''}
        visible={dialog?.kind === 'delete'}>
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          icon="trash-outline"
          label={t('projects.delete')}
          loading={workspace.actionBusy === 'project:delete'}
          onPress={async () => {
            if (dialog?.kind === 'delete' && await run({ action: 'delete', projectId: dialog.project.id })) close();
          }}
          tone="danger"
        />
        <PrimaryButton label={t('projects.keep')} onPress={close} tone="light" />
      </ActionModal>

      <ActionModal
        onClose={close}
        title={dialog?.kind === 'item' ? projectItemLabel(dialog.item) : ''}
        visible={dialog?.kind === 'item'}>
        {dialog?.kind === 'item' ? (
          <View style={styles.menu}>
            {dialog.item.kind !== 'link' ? (
              <PrimaryButton
                icon="create-outline"
                label={t('projects.renameFile')}
                onPress={() => {
                  setName(dialog.item.title ?? dialog.item.upload?.fileName ?? dialog.item.summary?.topic ?? '');
                  setNameError(null);
                  setDialog({ kind: 'renameItem', item: dialog.item });
                }}
                tone="light"
              />
            ) : null}
            <PrimaryButton
              icon="remove-circle-outline"
              label={t('projects.removeItem')}
              loading={workspace.actionBusy === 'project:remove_item'}
              onPress={async () => {
                if (dialog.kind === 'item' && await run({ action: 'remove_item', itemId: dialog.item.id })) close();
              }}
              tone="danger"
            />
            <ActionError message={workspace.actionError} />
          </View>
        ) : null}
      </ActionModal>

      {viewing?.upload?.previewUrl ? (
        <ImageViewerModal
          name={projectItemLabel(viewing)}
          onClose={() => setViewing(null)}
          onCopy={() => copyImage(async () => viewing.upload?.previewUrl)}
          onDownload={() => {
            if (viewing.upload) void workspace.downloadAttachmentById(conversation.id, viewing.upload.attachmentId);
          }}
          uri={viewing.upload.previewUrl}
          visible
        />
      ) : null}
    </View>
  );
}

function ProjectBranch({
  project,
  projects,
  index,
  open,
  selected,
  drawersOpen,
  onToggle,
  onToggleDrawer,
  onSelect,
  onOptions,
  onOpenItem,
  onItemOptions,
  onDownload,
}: {
  project: ConversationProject;
  projects: ConversationProjects;
  index: number;
  open: boolean;
  selected: boolean;
  drawersOpen: (kind: ProjectItemKind) => boolean;
  onToggle: () => void;
  onToggleDrawer: (kind: ProjectItemKind) => void;
  onSelect: () => void;
  onOptions: () => void;
  onOpenItem: (item: ProjectItem) => void;
  onItemOptions: (item: ProjectItem) => void;
  onDownload: (item: ProjectItem, format: 'pdf' | 'docx') => Promise<void>;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const rowRef = useContextMenu(onOptions);
  const label = `${index + 1}. ${project.name}`;
  return (
    <View style={styles.branch}>
      <View ref={rowRef} style={[styles.projectRow, selected && styles.projectRowSelected]}>
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={{ expanded: open, selected }}
          onLongPress={onOptions}
          onPress={onToggle}
          style={({ pressed }) => [styles.projectToggle, pressed && styles.pressed]}
          testID={`project-row-${index + 1}`}>
          <Ionicons color={colors.inkMuted} name={open ? 'chevron-down' : 'chevron-forward'} size={15} />
          <Text numberOfLines={1} style={styles.projectName}>{label}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={selected ? `${t('projects.stopUsing')}: ${project.name}` : `${t('projects.use')}: ${project.name}`}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          onPress={onSelect}
          style={({ pressed }) => [styles.useButton, selected && styles.useButtonSelected, pressed && styles.pressed]}>
          <Ionicons
            color={selected ? colors.white : colors.mintDark}
            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
            size={13}
          />
          <Text style={[styles.useText, selected && styles.useTextSelected]}>
            {selected ? t('projects.current') : t('projects.use')}
          </Text>
        </Pressable>
        <IconButton
          accessibilityLabel={`${t('projects.options')}: ${project.name}`}
          label={t('projects.options')}
          name="ellipsis-horizontal"
          onPress={onOptions}
          size={28}
        />
      </View>
      {open ? DRAWERS.map((drawer) => {
        const items = projectItems(projects, project.id, drawer.kind);
        const drawerOpen = drawersOpen(drawer.kind);
        const drawerLabel = `${t(drawer.labelKey)} (${items.length})`;
        return (
          <View key={drawer.kind} style={styles.drawer}>
            <Pressable
              accessibilityLabel={`${project.name} · ${drawerLabel}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: drawerOpen }}
              onPress={() => onToggleDrawer(drawer.kind)}
              style={({ pressed }) => [styles.drawerRow, pressed && styles.pressed]}>
              <Ionicons color={colors.inkSubtle} name={drawerOpen ? 'chevron-down' : 'chevron-forward'} size={13} />
              <Ionicons color={colors.plum} name={drawer.icon} size={15} />
              <Text style={styles.drawerLabel}>{drawerLabel}</Text>
            </Pressable>
            {drawerOpen ? (
              items.length ? items.map((item) => (
                <ItemRow
                  item={item}
                  key={item.id}
                  onDownload={onDownload}
                  onOpen={() => onOpenItem(item)}
                  onOptions={() => onItemOptions(item)}
                />
              )) : <Text style={styles.drawerEmpty}>{t('projects.drawerEmpty')}</Text>
            ) : null}
          </View>
        );
      }) : null}
    </View>
  );
}

function ItemRow({
  item,
  onOpen,
  onOptions,
  onDownload,
}: {
  item: ProjectItem;
  onOpen: () => void;
  onOptions: () => void;
  onDownload: (item: ProjectItem, format: 'pdf' | 'docx') => Promise<void>;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);
  const rowRef = useContextMenu(onOptions);
  const label = item.kind === 'link' && item.link && !item.title ? linkLabel(item.link.url) : projectItemLabel(item);
  const pending = item.summary?.state === 'pending';
  const meta = item.upload
    ? [item.senderName, mediaSizeLabel(item.upload.byteSize)].filter(Boolean).join(' · ')
    : item.link
      ? item.senderName
      : null;
  const exportAs = async (format: 'pdf' | 'docx') => {
    setExporting(format);
    try {
      await onDownload(item, format);
    } finally {
      setExporting(null);
    }
  };
  return (
    <View ref={rowRef} style={styles.itemRow} testID={`project-item-${item.kind}`}>
      <Pressable
        accessibilityLabel={pending ? t('projects.pendingSummary') : label}
        accessibilityRole={item.kind === 'summary' ? 'text' : item.kind === 'link' ? 'link' : 'button'}
        disabled={item.kind === 'summary'}
        onLongPress={onOptions}
        onPress={onOpen}
        style={({ pressed }) => [styles.itemMain, pressed && styles.pressed]}>
        {item.upload?.mediaKind === 'image' && item.upload.previewUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: item.upload.previewUrl }}
            style={styles.thumb}
          />
        ) : (
          <View style={styles.itemIcon}>
            <Ionicons
              color={colors.inkMuted}
              name={item.kind === 'summary'
                ? 'document-text-outline'
                : item.kind === 'link'
                  ? 'globe-outline'
                  : item.upload?.mediaKind === 'video'
                    ? 'videocam-outline'
                    : 'document-attach-outline'}
              size={15}
            />
          </View>
        )}
        <View style={styles.itemCopy}>
          {pending ? (
            <View style={styles.pendingRow}>
              <ActivityIndicator color={colors.plum} size="small" />
              <Text style={styles.itemMeta}>{t('projects.pendingSummary')}</Text>
            </View>
          ) : (
            // A summary's date is the part that must never be cut (owner's
            // father, Sep 23 2026), so its name gets the row's whole width and
            // three lines, and the file buttons sit underneath it.
            <Text
              numberOfLines={item.kind === 'summary' ? 3 : 2}
              selectable={item.kind === 'summary'}
              style={styles.itemName}>
              {label}
            </Text>
          )}
          {meta ? <Text numberOfLines={1} style={styles.itemMeta}>{meta}</Text> : null}
        </View>
      </Pressable>
      {!pending ? (
        <IconButton
          accessibilityLabel={t('projects.itemOptions').replace('{name}', label)}
          label={t('projects.itemOptions').replace('{name}', label)}
          name="ellipsis-vertical"
          onPress={onOptions}
          size={26}
        />
      ) : null}
      {item.kind === 'summary' && !pending ? (
        <View style={styles.formats}>
          <Pressable
            accessibilityLabel={`PDF: ${label}`}
            accessibilityRole="button"
            disabled={exporting !== null}
            onPress={() => void exportAs('pdf')}
            style={({ pressed }) => [styles.format, pressed && styles.pressed]}>
            {exporting === 'pdf' ? <ActivityIndicator size="small" color={colors.ink} /> : <Text style={styles.formatText}>PDF</Text>}
          </Pressable>
          <Pressable
            accessibilityLabel={`Word: ${label}`}
            accessibilityRole="button"
            disabled={exporting !== null}
            onPress={() => void exportAs('docx')}
            style={({ pressed }) => [styles.format, pressed && styles.pressed]}>
            {exporting === 'docx' ? <ActivityIndicator size="small" color={colors.ink} /> : <Text style={styles.formatText}>Word</Text>}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  panel: { gap: 2 },
  panelSidebar: {
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  headerRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32 },
  headerTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  headerCount: { color: colors.inkSubtle, fontSize: 12, fontWeight: '800' },
  spacer: { flex: 1 },
  loading: { paddingVertical: spacing.sm },
  empty: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, paddingVertical: spacing.xs },
  branch: { gap: 1 },
  projectRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingRight: 2,
    borderRadius: radii.sm,
  },
  projectRowSelected: { backgroundColor: colors.mintSoft },
  projectToggle: { flex: 1, minWidth: 0, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 2 },
  projectName: { flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '800' },
  useButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.mintDark,
  },
  useButtonSelected: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  useText: { color: colors.mintDark, fontSize: 11, fontWeight: '800' },
  useTextSelected: { color: colors.white },
  drawer: { paddingLeft: 20 },
  drawerRow: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6 },
  drawerLabel: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  drawerEmpty: { color: colors.inkSubtle, fontSize: 11, paddingLeft: 36, paddingBottom: 4 },
  itemRow: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingLeft: 16 },
  itemMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 4 },
  thumb: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.paper },
  itemIcon: {
    width: 30,
    height: 30,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  itemCopy: { flex: 1, minWidth: 0 },
  itemName: { color: colors.ink, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  itemMeta: { color: colors.inkSubtle, fontSize: 10, marginTop: 1 },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // The summary's file buttons take their own line, under the name.
  formats: { flexBasis: '100%', flexDirection: 'row', gap: 6, paddingLeft: 38, paddingBottom: 6 },
  format: {
    minWidth: 38,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderRadius: 7,
    backgroundColor: colors.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
  },
  formatText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  menu: { gap: spacing.xs },
  hint: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.6 },
});
