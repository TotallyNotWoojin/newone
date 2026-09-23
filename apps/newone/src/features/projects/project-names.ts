import type { ConversationProjects, ProjectItem, ProjectItemKind } from '@/data/repositories/contracts';

/** "2026-09-23" in the reader's own calendar: the date every summary file carries. */
export function projectDate(stamp: string): string {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * What a drawer row calls an item. A summary is "its name (its date)": the
 * AI's name until someone renames it, and the date it was made always after
 * it, whatever the name says (owner's father, Sep 23 2026: the summary file
 * must always carry the date it was made).
 */
export function projectItemLabel(item: ProjectItem): string {
  if (item.kind === 'summary') {
    const name = item.title ?? item.summary?.topic ?? '';
    const date = projectDate(item.summary?.createdAt ?? item.createdAt);
    return name ? `${name} (${date})` : `(${date})`;
  }
  if (item.kind === 'upload') return item.title ?? item.upload?.fileName ?? '';
  return item.title ?? item.link?.url ?? '';
}

/** A link as a person reads it: no scheme, no trailing slash. */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** "Acid delivery #1 (2026-09-23).pdf": the drawer's own label, safe on every file system. */
export function projectSummaryFileName(item: ProjectItem, format: 'pdf' | 'docx'): string {
  const label = projectItemLabel(item).replace(UNSAFE_FILE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return `${label || 'Summary'}.${format}`;
}

export function projectItems(
  projects: ConversationProjects | null,
  projectId: string,
  kind: ProjectItemKind,
): ProjectItem[] {
  return projects?.items.filter((item) => item.projectId === projectId && item.kind === kind) ?? [];
}

/** Project names compare the way the server's uniqueness rule does. */
export function projectNameTaken(
  projects: ConversationProjects | null,
  name: string,
  exceptProjectId?: string,
): boolean {
  const wanted = name.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return Boolean(projects?.projects.some((project) =>
    project.id !== exceptProjectId && project.name.toLocaleLowerCase() === wanted));
}
