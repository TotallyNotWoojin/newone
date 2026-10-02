import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { Image as CachedImage } from 'expo-image';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
// Metro selects the platform file (a card beside the ⋯ on the web, nothing on a phone).
// eslint-disable-next-line import/no-unresolved
import { AnchoredPopover } from '@/components/ui/anchored-popover';
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
import { showProject } from '@/features/projects/project-view';
import { SummaryPreview } from '@/features/projects/summary-preview';
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
  | { kind: 'delete'; project: ConversationProject }
  | { kind: 'item'; item: ProjectItem }
  | { kind: 'renameItem'; item: ProjectItem }
  | null;

/** How a project's drawers are showing: beside its ⋯ on the web, or under its row. */
type Details = { projectId: string; pinned: boolean };

const CARD_WIDTH = 340;
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 280;

/**
 * A chat's projects as the owner's father drew them (Sep 23 2026), folded to
 * their names (Oct 1 2026: "I can't even see their names anymore since too
 * much content is pushed down below"). Tapping a name saves into that project
 * and takes the chat to where its conversation got to; the ⋯ beside it holds
 * the three drawers (the summaries saved into it, the files and photos people
 * sent, the links they shared) and the project's own options. On the web's
 * sidebar the ⋯ opens a card on a hover or a click; in a sheet it unfolds the
 * project in place. Everyone in the chat sees the same projects; the one
 * marked "Saving here" is where this reader's own messages, files, links and
 * summaries go.
 */
export function ProjectsPanel({
  conversation,
  variant = 'sheet',
  onProjectOpened,
}: {
  conversation: Conversation;
  /** The sidebar hangs the tree under the open chat's row; the sheet is the phone's (and the header button's) view. */
  variant?: 'sheet' | 'sidebar';
  /** A project was tapped and the chat is on its way there: the sheet steps aside. */
  onProjectOpened?: () => void;
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
  const [reading, setReading] = useState<ProjectItem | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  // The sidebar tree folds to its one header line when the reader wants the
  // list back; the sheet always shows everything.
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = variant === 'sidebar';
  // A card beside the ⋯ needs a pointer and room beside the list: the web's
  // sidebar. A sheet unfolds the project under its row instead.
  const floating = sidebar && Platform.OS === 'web';
  const headerRef = useContextMenu(() => openCreate());
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isOpen = (key: string, fallback: boolean) => expanded[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? fallback) }));

  const stopHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => stopHover, []);
  // Whatever the card opens (a menu, a summary, a photo) takes its place.
  const stepAside = () => {
    if (floating) setDetails(null);
  };

  // The pointer resting on a ⋯ opens its card; leaving both the ⋯ and the
  // card puts it away, unless a click pinned it open.
  const hoverDetails = (projectId: string) => {
    stopHover();
    hoverTimer.current = setTimeout(() => {
      setDetails((current) => (current?.projectId === projectId ? current : { projectId, pinned: false }));
    }, HOVER_OPEN_MS);
  };
  const keepDetails = () => stopHover();
  const leaveDetails = () => {
    stopHover();
    hoverTimer.current = setTimeout(() => {
      setDetails((current) => (current && !current.pinned ? null : current));
    }, HOVER_CLOSE_MS);
  };
  const pressDetails = (projectId: string) => {
    stopHover();
    workspace.clearActionError();
    setOpenFailed(false);
    setDetails((current) => (current?.projectId === projectId && (current.pinned || !floating)
      ? null
      : { projectId, pinned: true }));
  };

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

  const list = projects?.projects ?? [];
  const labelOf = (project: ConversationProject) => `${list.indexOf(project) + 1}. ${project.name}`;

  // "Pressing the project name should also start and save" (owner's father,
  // Oct 1 2026): a name saves into its project, like the Save here button,
  // and the chat shows that project's conversation on its own, from where it
  // ended (owner's decision the same day).
  const openProject = async (project: ConversationProject) => {
    if (opening) return;
    workspace.clearActionError();
    setOpenFailed(false);
    if (projects?.selectedProjectId !== project.id) {
      setOpening(project.id);
      const result = await run({ action: 'select', projectId: project.id });
      setOpening(null);
      if (!result) {
        setOpenFailed(true);
        return;
      }
    }
    setDetails(null);
    showProject(conversation.id, project.id);
    onProjectOpened?.();
  };

  const stopSaving = async () => {
    workspace.clearActionError();
    setOpenFailed(false);
    if (await run({ action: 'select', projectId: null })) showProject(conversation.id, null);
    else setOpenFailed(true);
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
      if (result) close();
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
    if (item.summary) {
      if (item.summary.state !== 'pending') {
        workspace.clearActionError();
        stepAside();
        setReading(item);
      }
      return;
    }
    if (item.link) {
      void Linking.openURL(item.link.url);
      return;
    }
    if (item.upload?.mediaKind === 'image' && item.upload.previewUrl) {
      stepAside();
      setViewing(item);
      return;
    }
    if (item.upload) {
      void workspace.downloadAttachmentById(conversation.id, item.upload.attachmentId, {
        fileName: item.upload.fileName,
        mimeType: item.upload.mimeType,
      });
    }
  };

  const renderDetails = (project: ConversationProject) => (
    <ProjectDetails
      drawersOpen={(kind) => isOpen(`${project.id}:${kind}`, projectItems(projects, project.id, kind).length > 0)}
      floating={floating}
      label={labelOf(project)}
      onDelete={() => {
        workspace.clearActionError();
        stepAside();
        setDialog({ kind: 'delete', project });
      }}
      onDownload={download}
      onItemOptions={(item) => {
        workspace.clearActionError();
        stepAside();
        setDialog({ kind: 'item', item });
      }}
      onOpenItem={openItem}
      onRename={() => {
        workspace.clearActionError();
        stepAside();
        setName(project.name);
        setNameError(null);
        setDialog({ kind: 'rename', project });
      }}
      onToggleDrawer={(kind) =>
        toggle(`${project.id}:${kind}`, projectItems(projects, project.id, kind).length > 0)}
      project={project}
      projects={projects as ConversationProjects}
    />
  );

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
        <ActivityIndicator accessibilityLabel={t('projects.title')} color={colors.mintDark} style={styles.loading} />
      ) : list.length === 0 ? (
        sidebar ? null : <Text style={styles.empty}>{t('projects.empty')}</Text>
      ) : (
        list.map((project, index) => (
          <ProjectBranch
            details={details?.projectId === project.id ? renderDetails(project) : null}
            detailsOpen={details?.projectId === project.id}
            floating={floating}
            index={index}
            key={project.id}
            onCloseDetails={() => setDetails(null)}
            onDetailsHover={(inside) => (inside ? hoverDetails(project.id) : leaveDetails())}
            onDetailsKeep={keepDetails}
            onDetailsPress={() => pressDetails(project.id)}
            onOpen={() => void openProject(project)}
            onToggleSaving={() => (project.id === projects.selectedProjectId
              ? void stopSaving()
              : void openProject(project))}
            opening={opening === project.id}
            project={project}
            selected={project.id === projects.selectedProjectId}
          />
        ))
      )}
      {openFailed ? <ActionError message={workspace.actionError} /> : null}

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
          cacheKey={`original:${viewing.upload.attachmentId}`}
          onDownload={() => (viewing.upload
            ? workspace.downloadAttachmentById(conversation.id, viewing.upload.attachmentId, {
              fileName: viewing.upload.fileName,
              mimeType: viewing.upload.mimeType,
            })
            : undefined)}
          uri={viewing.upload.previewUrl}
          visible
        />
      ) : null}
      {reading ? (
        <SummaryPreview
          conversationId={conversation.id}
          item={reading}
          onClose={() => setReading(null)}
          onDownload={download}
        />
      ) : null}
    </View>
  );
}

function ProjectBranch({
  project,
  index,
  selected,
  opening,
  floating,
  detailsOpen,
  details,
  onOpen,
  onToggleSaving,
  onDetailsPress,
  onDetailsHover,
  onDetailsKeep,
  onCloseDetails,
}: {
  project: ConversationProject;
  index: number;
  selected: boolean;
  opening: boolean;
  floating: boolean;
  detailsOpen: boolean;
  details: ReactNode;
  onOpen: () => void;
  onToggleSaving: () => void;
  onDetailsPress: () => void;
  onDetailsHover: (inside: boolean) => void;
  onDetailsKeep: () => void;
  onCloseDetails: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const rowRef = useContextMenu(onDetailsPress);
  const moreRef = useRef<View>(null);
  const label = `${index + 1}. ${project.name}`;
  return (
    <View style={styles.branch}>
      <View ref={rowRef} style={[styles.projectRow, selected && styles.projectRowSelected]}>
        <Pressable
          accessibilityHint={t('projects.openHint')}
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={{ selected, busy: opening }}
          onLongPress={onDetailsPress}
          onPress={onOpen}
          style={({ pressed }) => [styles.projectName, pressed && styles.pressed]}
          testID={`project-row-${index + 1}`}>
          <Ionicons
            color={selected ? colors.mintDark : colors.inkMuted}
            name={selected ? 'folder-open' : 'folder-outline'}
            size={15}
          />
          <Text numberOfLines={1} style={styles.projectNameText}>{label}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={selected ? `${t('projects.stopUsing')}: ${project.name}` : `${t('projects.use')}: ${project.name}`}
          accessibilityRole="button"
          accessibilityState={{ selected, busy: opening }}
          disabled={opening}
          onPress={onToggleSaving}
          style={({ pressed }) => [styles.useButton, selected && styles.useButtonSelected, pressed && styles.pressed]}>
          {opening ? (
            <ActivityIndicator color={colors.mintDark} size="small" style={styles.useSpinner} />
          ) : (
            <Ionicons
              color={selected ? colors.white : colors.mintDark}
              name={selected ? 'checkmark-circle' : 'ellipse-outline'}
              size={13}
            />
          )}
          <Text style={[styles.useText, selected && styles.useTextSelected]}>
            {selected ? t('projects.current') : t('projects.use')}
          </Text>
        </Pressable>
        <View
          onPointerEnter={floating ? () => onDetailsHover(true) : undefined}
          onPointerLeave={floating ? () => onDetailsHover(false) : undefined}
          ref={moreRef}>
          <Pressable
            accessibilityLabel={`${t('projects.options')}: ${project.name}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            hitSlop={6}
            onPress={onDetailsPress}
            style={({ pressed }) => [styles.more, detailsOpen && styles.moreOpen, pressed && styles.pressed]}
            testID={`project-more-${index + 1}`}>
            <Ionicons color={colors.ink} name="ellipsis-horizontal" size={15} />
          </Pressable>
        </View>
      </View>
      {floating && detailsOpen ? (
        <AnchoredPopover
          accessibilityLabel={label}
          anchor={moreRef}
          onClose={onCloseDetails}
          onPointerEnter={onDetailsKeep}
          onPointerLeave={() => onDetailsHover(false)}
          testID={`project-details-${index + 1}`}
          visible={detailsOpen}
          width={CARD_WIDTH}>
          {details}
        </AnchoredPopover>
      ) : detailsOpen && !floating ? (
        <View style={styles.unfolded} testID={`project-details-${index + 1}`}>{details}</View>
      ) : null}
    </View>
  );
}

/** What the ⋯ holds: the three drawers, then renaming or deleting the project. */
function ProjectDetails({
  project,
  projects,
  label,
  floating,
  drawersOpen,
  onToggleDrawer,
  onOpenItem,
  onItemOptions,
  onDownload,
  onRename,
  onDelete,
}: {
  project: ConversationProject;
  projects: ConversationProjects;
  label: string;
  floating: boolean;
  drawersOpen: (kind: ProjectItemKind) => boolean;
  onToggleDrawer: (kind: ProjectItemKind) => void;
  onOpenItem: (item: ProjectItem) => void;
  onItemOptions: (item: ProjectItem) => void;
  onDownload: (item: ProjectItem, format: 'pdf' | 'docx') => Promise<void>;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const drawers = DRAWERS.map((drawer) => {
    const items = projectItems(projects, project.id, drawer.kind);
    const drawerOpen = drawersOpen(drawer.kind);
    const drawerLabel = `${t(drawer.labelKey)} (${items.length})`;
    return (
      <View key={drawer.kind} style={[styles.drawer, floating && styles.drawerFloating]}>
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
  });
  const actions = (
    <View style={[styles.detailActions, floating && styles.detailActionsFloating]}>
      <Pressable
        accessibilityLabel={`${t('projects.rename')}: ${project.name}`}
        accessibilityRole="button"
        onPress={onRename}
        style={({ pressed }) => [styles.detailAction, pressed && styles.pressed]}>
        <Ionicons color={colors.inkMuted} name="create-outline" size={14} />
        <Text style={styles.detailActionText}>{t('projects.rename')}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={`${t('projects.delete')}: ${project.name}`}
        accessibilityRole="button"
        onPress={onDelete}
        style={({ pressed }) => [styles.detailAction, pressed && styles.pressed]}>
        <Ionicons color={colors.red} name="trash-outline" size={14} />
        <Text style={[styles.detailActionText, styles.detailActionDanger]}>{t('projects.delete')}</Text>
      </Pressable>
    </View>
  );
  if (!floating) {
    return (
      <View>
        {drawers}
        {actions}
      </View>
    );
  }
  return (
    <View style={styles.cardColumn}>
      <Text numberOfLines={2} style={styles.cardTitle}>{label}</Text>
      <ScrollView contentContainerStyle={styles.cardDrawers} style={styles.cardScroll}>
        {drawers}
      </ScrollView>
      {actions}
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
        accessibilityHint={item.kind === 'summary' && !pending ? t('projects.readSummary') : undefined}
        accessibilityLabel={pending ? t('projects.pendingSummary') : label}
        accessibilityRole={item.kind === 'link' ? 'link' : 'button'}
        disabled={pending}
        onLongPress={onOptions}
        onPress={onOpen}
        style={({ pressed }) => [styles.itemMain, pressed && styles.pressed]}>
        {item.upload?.mediaKind === 'image' && item.upload.previewUrl ? (
          // Every projects read signs a new link; the photo is cached by its
          // id, so the drawer never downloads it twice.
          <CachedImage
            cachePolicy="memory-disk"
            contentFit="cover"
            source={{ uri: item.upload.previewUrl, cacheKey: `original:${item.upload.attachmentId}` }}
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
              <ActivityIndicator accessibilityLabel={t('projects.pendingSummary')} color={colors.plum} size="small" />
              <Text style={styles.itemMeta}>{t('projects.pendingSummary')}</Text>
            </View>
          ) : (
            // A summary's date is the part that must never be cut (owner's
            // father, Sep 23 2026), so its name gets the row's whole width and
            // three lines, and the file buttons sit underneath it.
            <Text
              numberOfLines={item.kind === 'summary' ? 3 : 2}
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
            {exporting === 'pdf' ? <ActivityIndicator accessibilityLabel="PDF" size="small" color={colors.ink} /> : <Text style={styles.formatText}>PDF</Text>}
          </Pressable>
          <Pressable
            accessibilityLabel={`Word: ${label}`}
            accessibilityRole="button"
            disabled={exporting !== null}
            onPress={() => void exportAs('docx')}
            style={({ pressed }) => [styles.format, pressed && styles.pressed]}>
            {exporting === 'docx' ? <ActivityIndicator accessibilityLabel="Word" size="small" color={colors.ink} /> : <Text style={styles.formatText}>Word</Text>}
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
  projectName: { flex: 1, minWidth: 0, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4 },
  projectNameText: { flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '800' },
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
  useSpinner: { width: 13, height: 13, transform: [{ scale: 0.6 }] },
  more: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: colors.paperMuted,
  },
  moreOpen: { backgroundColor: colors.mintSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.mintDark },
  unfolded: {
    marginLeft: 6,
    marginBottom: 4,
    paddingLeft: 6,
    borderLeftWidth: 2,
    borderLeftColor: colors.mintSoft,
  },
  cardColumn: { flexShrink: 1, minHeight: 0, paddingTop: spacing.sm },
  cardTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  cardScroll: { flexShrink: 1 },
  cardDrawers: { paddingHorizontal: spacing.xs, paddingBottom: 4 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 20, paddingTop: 2, paddingBottom: 6 },
  detailActionsFloating: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  detailAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: colors.paperMuted,
  },
  detailActionText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  detailActionDanger: { color: colors.red },
  drawer: { paddingLeft: 20 },
  drawerFloating: { paddingLeft: 4 },
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
