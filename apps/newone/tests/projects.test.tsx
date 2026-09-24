import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';

import type { ConversationProjects } from '@/data/repositories/contracts';
import {
  conversationProjectsFromDto,
  keywordFindFromDto,
  summaryReadinessFromDto,
  summaryViewFromDto,
} from '@/data/repositories/project-dto';
import { copyImage } from '@/features/chat/copy-image';
import {
  projectDate,
  projectItemLabel,
  projectNameTaken,
  projectSummaryFileName,
} from '@/features/projects/project-names';
import { ProjectsPanel } from '@/features/projects/projects-panel';
import { ActiveProjectBar } from '@/features/projects/project-sheets';
import { resetConversationProjectsStore } from '@/features/projects/use-conversation-projects';
import { highlightParts, KeywordFindModal } from '@/features/search/keyword-find';
import { projectWorkspaceFields } from './fixtures/project-workspace';

let mockWorkspace: Record<string, any>;
const mockSaveSummaryFile = jest.fn(async (..._args: unknown[]) => 'saved');
const mockOpenUrl = jest.fn(async (..._args: unknown[]) => true);

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));
jest.mock('@/features/chat/summary-export', () => ({
  saveSummaryFile: (...args: unknown[]) => mockSaveSummaryFile(...args),
}));

const conversation = {
  id: 'conversation-a',
  title: 'Administration Team',
  initials: 'AT',
  avatarColor: '#123456',
  kind: 'group',
} as never;

function projectsPayload(): ConversationProjects {
  return {
    conversationId: 'conversation-a',
    selectedProjectId: 'project-1',
    projects: [
      { id: 'project-1', name: 'HDG', createdByUserId: 'user-self', createdAt: '2026-09-23T01:00:00.000Z' },
      { id: 'project-2', name: 'Maintenance', createdByUserId: 'user-other', createdAt: '2026-09-23T01:01:00.000Z' },
    ],
    items: [
      {
        id: 'item-summary',
        projectId: 'project-1',
        kind: 'summary',
        title: 'Acid delivery #1',
        addedByUserId: 'user-self',
        createdAt: '2026-09-23T02:00:00.000Z',
        senderId: null,
        senderName: '',
        summary: { summaryId: 'summary-1', state: 'ready', topic: 'Acid delivery', language: 'en', createdAt: '2026-09-23T02:00:00.000Z' },
        upload: null,
        link: null,
      },
      {
        id: 'item-upload',
        projectId: 'project-1',
        kind: 'upload',
        title: null,
        addedByUserId: 'user-self',
        createdAt: '2026-09-23T02:01:00.000Z',
        senderId: 'user-self',
        senderName: 'Kyle',
        summary: null,
        upload: {
          attachmentId: 'attachment-1',
          messageId: '41',
          fileName: 'HT contract.pdf',
          mimeType: 'application/pdf',
          byteSize: 2048,
          mediaKind: 'file',
          previewUrl: null,
        },
        link: null,
      },
      {
        id: 'item-link',
        projectId: 'project-1',
        kind: 'link',
        title: null,
        addedByUserId: 'user-self',
        createdAt: '2026-09-23T02:02:00.000Z',
        senderId: 'user-self',
        senderName: 'Kyle',
        summary: null,
        upload: null,
        link: { url: 'https://www.newoneinc.com/', messageId: '42' },
      },
    ],
  };
}

function buildWorkspace() {
  return {
    ...projectWorkspaceFields(),
    currentUser: { id: 'user-self', displayName: 'Kyle' },
    actionBusy: null,
    actionError: null,
    clearActionError: jest.fn(),
    conversations: [conversation],
    conversationAvatarUrls: {},
    loadConversationProjects: jest.fn(async () => projectsPayload()),
    runProjectCommand: jest.fn(async () => ({ projectId: 'project-3', itemId: null, selectedProjectId: 'project-3' })),
    exportSummaryFile: jest.fn(async () => ({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' })),
    viewSummary: jest.fn(async () => ({
      title: 'Acid delivery',
      covers: 'Sep 23, 9:00 AM – 5:00 PM',
      participants: ['Kyle', 'Ana', 'Luis'],
      lines: ['1. The acid delivery arrives at Otay on Friday.', '2. Francisco confirms it in the warehouse.'],
      createdAt: '2026-09-23T17:00:00.000Z',
    })),
  };
}

beforeEach(() => {
  jest.spyOn(Linking, 'openURL').mockImplementation((...args: unknown[]) => mockOpenUrl(...args) as never);
  resetConversationProjectsStore();
  mockWorkspace = buildWorkspace();
  mockSaveSummaryFile.mockClear();
  mockOpenUrl.mockClear();
});

describe('reading projects from the service', () => {
  const dto = {
    schemaVersion: 1,
    conversationId: 'conversation-a',
    selectedProjectId: 'project-1',
    projects: [{ projectId: 'project-1', name: 'HDG', createdByUserId: 'u1', createdAt: '2026-09-23T01:00:00Z' }],
    items: [
      {
        itemId: 'i1', projectId: 'project-1', kind: 'summary', title: null, addedByUserId: 'u1',
        createdAt: '2026-09-23T01:00:00Z', summaryId: 's1', summaryState: 'pending', summaryTopic: null,
        summaryLanguage: 'ko', summaryCreatedAt: '2026-09-23T01:00:00Z',
      },
      {
        itemId: 'i2', projectId: 'project-1', kind: 'upload', title: null, addedByUserId: 'u1',
        createdAt: '2026-09-23T01:00:00Z', attachmentId: 'a1', messageId: '7', fileName: 'photo.jpg',
        mimeType: 'image/jpeg', byteSize: 10, mediaKind: 'image', previewUrl: 'javascript:alert(1)',
      },
      { itemId: 'i3', projectId: 'gone', kind: 'link', url: 'https://a.com/', messageId: '8', addedByUserId: 'u1', createdAt: '2026-09-23T01:00:00Z' },
      {
        itemId: 'i4', projectId: 'project-1', kind: 'summary', title: 'x', addedByUserId: 'u1',
        createdAt: '2026-09-23T01:00:00Z', summaryId: 's2', summaryState: null, summaryCreatedAt: '2026-09-23T01:00:00Z',
      },
    ],
  };

  test('keeps items of known projects, drops finished-but-failed summaries, and never trusts a non-https preview', () => {
    const parsed = conversationProjectsFromDto(dto, 'conversation-a');
    expect(parsed.selectedProjectId).toBe('project-1');
    expect(parsed.items.map((item) => item.id)).toEqual(['i1', 'i2']);
    expect(parsed.items[0]?.summary?.state).toBe('pending');
    expect(parsed.items[1]?.upload?.previewUrl).toBeNull();
  });

  test('refuses an answer about another chat or a link without https', () => {
    expect(() => conversationProjectsFromDto(dto, 'conversation-b')).toThrow();
    expect(() => conversationProjectsFromDto({
      ...dto,
      items: [{ itemId: 'i', projectId: 'project-1', kind: 'link', url: 'http://a.com/', messageId: '1', addedByUserId: 'u', createdAt: '2026-09-23T01:00:00Z' }],
    }, 'conversation-a')).toThrow();
  });

  test('reads a summary to show in the app, and refuses a malformed one', () => {
    expect(summaryViewFromDto({
      schemaVersion: 1,
      title: 'Acid delivery',
      covers: null,
      participants: ['Kyle'],
      lines: ['1. Friday.'],
      createdAt: '2026-09-23T17:00:00.000Z',
    })).toEqual({ title: 'Acid delivery', covers: null, participants: ['Kyle'], lines: ['1. Friday.'], createdAt: '2026-09-23T17:00:00.000Z' });
    expect(() => summaryViewFromDto({ title: 'x', covers: null, participants: [], lines: [1], createdAt: '2026-09-23T17:00:00.000Z' }))
      .toThrow();
    expect(() => summaryViewFromDto({ title: '', covers: null, participants: [], lines: [], createdAt: '2026-09-23T17:00:00.000Z' }))
      .toThrow();
  });

  test('reads every range of summary readiness and the find results', () => {
    const range = { messages: 4, characters: 300, ready: true, tooLong: false };
    const readiness = summaryReadinessFromDto({
      schemaVersion: 1,
      conversationId: 'conversation-a',
      minimumMessages: 3,
      minimumCharacters: 200,
      ranges: Object.fromEntries(['unread', 'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything']
        .map((kind) => [kind, range])),
    }, 'conversation-a');
    expect(readiness.ranges.everything.ready).toBe(true);
    // As the gateway really sends it (web suite, Sep 23 2026): every key
    // camel-cased, which stops at a digit.
    const live = summaryReadinessFromDto({
      schemaVersion: 1,
      conversationId: 'conversation-a',
      minimumMessages: 3,
      minimumCharacters: 200,
      ranges: {
        today: { ready: false, messages: 4, tooLong: false, characters: 158 },
        unread: { ready: false, messages: 1, tooLong: false, characters: 35 },
        yesterday: { ready: false, messages: 0, tooLong: false, characters: 0 },
        everything: { ready: false, messages: 4, tooLong: false, characters: 158 },
        last_7Days: { ready: true, messages: 5, tooLong: false, characters: 400 },
        last_30Days: { ready: false, messages: 4, tooLong: false, characters: 158 },
        last_90Days: { ready: false, messages: 4, tooLong: false, characters: 158 },
      },
    }, 'conversation-a');
    expect(live.ranges.last_7_days).toEqual({ messages: 5, characters: 400, ready: true, tooLong: false });
    expect(live.ranges.everything.ready).toBe(false);
    expect(() => summaryReadinessFromDto({ schemaVersion: 1, conversationId: 'conversation-a', ranges: {} }, 'conversation-a')).toThrow();
    const found = keywordFindFromDto({
      schemaVersion: 1,
      results: [{
        conversationId: 'c1', messageCount: 3, latestMessageId: '9', latestMessageAt: '2026-09-23T01:00:00Z',
        snippet: '회의록', projects: [{ projectId: 'p1', name: 'HDG' }],
        items: [{ projectId: 'p1', projectName: 'HDG', kind: 'upload', title: 'contract.pdf' }],
      }],
    }, 30);
    expect(found[0]?.messageCount).toBe(3);
    expect(found[0]?.items[0]?.title).toBe('contract.pdf');
    expect(() => keywordFindFromDto({ schemaVersion: 1, results: [{}, {}] }, 1)).toThrow();
  });
});

describe('names and dates in the drawers', () => {
  test('a summary always shows its date after its name, renamed or not, and its file carries both', () => {
    const [summaryItem] = projectsPayload().items;
    const date = projectDate('2026-09-23T02:00:00.000Z');
    expect(date).toMatch(/^2026-09-2[23]$/);
    expect(projectItemLabel(summaryItem!)).toBe(`Acid delivery #1 (${date})`);
    expect(projectItemLabel({ ...summaryItem!, title: 'For Luis' })).toBe(`For Luis (${date})`);
    expect(projectSummaryFileName({ ...summaryItem!, title: 'A/B: "plan"?' }, 'pdf')).toBe(`A B plan (${date}).pdf`);
  });

  test('project names compare without case or extra spaces', () => {
    const projects = projectsPayload();
    expect(projectNameTaken(projects, '  hdg ')).toBe(true);
    expect(projectNameTaken(projects, 'HDG', 'project-1')).toBe(false);
    expect(projectNameTaken(projects, 'Salary')).toBe(false);
  });

  test('the keyword is picked out wherever it appears', () => {
    expect(highlightParts('Acid arrives; ACID paid', 'acid')).toEqual([
      { text: 'Acid', match: true },
      { text: ' arrives; ', match: false },
      { text: 'ACID', match: true },
      { text: ' paid', match: false },
    ]);
  });
});

describe('the projects tree', () => {
  test('numbers the projects, marks the one being saved into, and opens its three drawers with their contents', async () => {
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('1. HDG')).toBeTruthy());
    expect(screen.getByText('2. Maintenance')).toBeTruthy();
    expect(screen.getByText('projects.current')).toBeTruthy();
    expect(screen.getByText('projects.drawerSummaries (1)')).toBeTruthy();
    expect(screen.getByText('projects.drawerUploads (1)')).toBeTruthy();
    expect(screen.getByText('projects.drawerLinks (1)')).toBeTruthy();
    expect(screen.getByText(/^Acid delivery #1 \(2026-09-2\d\)$/)).toBeTruthy();
    expect(screen.getByText('HT contract.pdf')).toBeTruthy();
    expect(screen.getByText('www.newoneinc.com')).toBeTruthy();
  });

  test('a summary downloads as a dated file, a file opens, and a link opens', async () => {
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('1. HDG')).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/^PDF: Acid delivery #1/));
    await waitFor(() => expect(mockSaveSummaryFile).toHaveBeenCalled());
    // The button shows PDF again once the file is out.
    await waitFor(() => expect(screen.getByText('PDF')).toBeTruthy());
    expect(mockWorkspace.exportSummaryFile).toHaveBeenCalledWith('conversation-a', 'summary-1', 'pdf');
    expect((mockSaveSummaryFile.mock.calls[0]?.[0] as { fileName: string }).fileName)
      .toMatch(/^Acid delivery #1 \(2026-09-2\d\)\.pdf$/);
    fireEvent.press(screen.getByLabelText('HT contract.pdf'));
    await waitFor(() => expect(mockWorkspace.downloadAttachmentById)
      .toHaveBeenCalledWith('conversation-a', 'attachment-1'));
    fireEvent.press(screen.getByLabelText('www.newoneinc.com'));
    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith('https://www.newoneinc.com/'));
  });

  test('a summary opens to read in the app, and its files are still one tap away', async () => {
    // "I shouldn't have to download to view the summaries" (owner, Sep 24 2026).
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('1. HDG')).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/^Acid delivery #1 \(2026-09-2\d\)$/));
    await waitFor(() => expect(screen.getByTestId('summary-preview')).toBeTruthy());
    expect(mockWorkspace.viewSummary).toHaveBeenCalledWith('conversation-a', 'summary-1');
    await waitFor(() => expect(screen.getByText('1. The acid delivery arrives at Otay on Friday.')).toBeTruthy());
    expect(screen.getByText('2. Francisco confirms it in the warehouse.')).toBeTruthy();
    expect(screen.getByText('Kyle, Ana, Luis')).toBeTruthy();
    expect(screen.getByText('Sep 23, 9:00 AM – 5:00 PM')).toBeTruthy();
    expect(mockSaveSummaryFile).not.toHaveBeenCalled();
    const inPreview = screen.getAllByLabelText(/^Word: Acid delivery #1/);
    fireEvent.press(inPreview[inPreview.length - 1] as never);
    await waitFor(() => expect(mockWorkspace.exportSummaryFile).toHaveBeenCalledWith('conversation-a', 'summary-1', 'docx'));
  });

  test('a summary that cannot be read says so instead of spinning', async () => {
    mockWorkspace.viewSummary = jest.fn(async () => null);
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('1. HDG')).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/^Acid delivery #1 \(2026-09-2\d\)$/));
    await waitFor(() => expect(screen.getByText('projects.summaryUnavailable')).toBeTruthy());
  });

  test('a new project is named by the reader, and a name the chat already has is caught before sending', async () => {
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('1. HDG')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('projects.new'));
    await waitFor(() => expect(screen.getByTestId('project-name-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('project-name-input'), 'hdg');
    await waitFor(() => expect(screen.getByTestId('project-name-input').props.value).toBe('hdg'));
    fireEvent.press(screen.getByTestId('project-name-save'));
    await waitFor(() => expect(screen.getByText('projects.nameTaken')).toBeTruthy());
    expect(mockWorkspace.runProjectCommand).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('project-name-input'), '  Salary  ');
    await waitFor(() => expect(screen.getByTestId('project-name-input').props.value).toBe('  Salary  '));
    await waitFor(() => expect(screen.queryByText('projects.nameTaken')).toBeNull());
    fireEvent.press(screen.getByTestId('project-name-save'));
    await waitFor(() => expect(mockWorkspace.runProjectCommand)
      .toHaveBeenCalledWith('conversation-a', { action: 'create', name: 'Salary' }));
  });

  test('saving into another project, and renaming a summary file, go to the server as commands', async () => {
    await render(<ProjectsPanel conversation={conversation} />);
    await waitFor(() => expect(screen.getByText('2. Maintenance')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('projects.use: Maintenance'));
    await waitFor(() => expect(mockWorkspace.runProjectCommand)
      .toHaveBeenCalledWith('conversation-a', { action: 'select', projectId: 'project-2' }));
    // The summary's menu: rename it; the date is not part of what is typed.
    fireEvent.press(screen.getAllByLabelText('projects.itemOptions')[0]!);
    await waitFor(() => expect(screen.getByLabelText('projects.renameFile')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('projects.renameFile'));
    await waitFor(() => expect(screen.getByTestId('project-name-input').props.value).toBe('Acid delivery #1'));
    expect(screen.getByText('projects.fileNameHint')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('project-name-input'), 'Acid for Luis');
    await waitFor(() => expect(screen.getByTestId('project-name-input').props.value).toBe('Acid for Luis'));
    fireEvent.press(screen.getByTestId('project-name-save'));
    await waitFor(() => expect(mockWorkspace.runProjectCommand)
      .toHaveBeenCalledWith('conversation-a', { action: 'rename_item', itemId: 'item-summary', name: 'Acid for Luis' }));
  });

  test('the bar over the composer names the project being saved into and can stop it', async () => {
    const onOpen = jest.fn();
    await render(<ActiveProjectBar conversation={conversation} onOpenProjects={onOpen} />);
    await waitFor(() => expect(screen.getByText('projects.activeBar')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('projects.stopUsing'));
    await waitFor(() => expect(mockWorkspace.runProjectCommand)
      .toHaveBeenCalledWith('conversation-a', { action: 'select', projectId: null }));
    fireEvent.press(screen.getByLabelText('projects.activeBar'));
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
  });
});

describe('copying a picture on the web', () => {
  const originalOs = Platform.OS;
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalItem;
    globalThis.fetch = originalFetch;
  });

  function webClipboard(write: (items: unknown[]) => Promise<void>) {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { write } }, configurable: true });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    };
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    })) as never;
  }

  test('the clipboard write starts inside the click, before the picture\'s address has even arrived', async () => {
    const order: string[] = [];
    let release: (url: string) => void = () => undefined;
    webClipboard(async (items) => {
      order.push('write');
      await (items[0] as { items: Record<string, Promise<Blob>> }).items['image/png'];
      order.push('picture');
    });
    const copying = copyImage(() => new Promise<string>((resolve) => {
      order.push('asked for address');
      release = resolve;
    }));
    // Nothing has been awaited yet: the write is already under way.
    expect(order).toEqual(['asked for address', 'write']);
    release('https://project.supabase.co/storage/v1/object/sign/photo');
    await expect(copying).resolves.toBe('copied');
    expect(order).toEqual(['asked for address', 'write', 'picture']);
  });

  test('a refused write or a missing picture is reported, never swallowed', async () => {
    webClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyImage(async () => 'https://a.example/photo.png')).resolves.toBe('failed');
    webClipboard(async (items) => {
      await (items[0] as { items: Record<string, Promise<Blob>> }).items['image/png'];
    });
    await expect(copyImage(async () => null)).resolves.toBe('failed');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    await expect(copyImage(async () => 'https://a.example/photo.png')).resolves.toBe('unsupported');
  });
});

// Last in the file: a debounced search that resolved leaves React's act
// bookkeeping mid-flight, and the next render in the same file would inherit it.
describe('찾기 (find by keyword)', () => {
  test('says when nothing matched', async () => {
    mockWorkspace.findKeyword = jest.fn(async (query: string) => (query === 'zzz' ? [] : null));
    await render(<KeywordFindModal onClose={() => undefined} onOpen={() => undefined} visible />);
    await waitFor(() => expect(screen.getByText('find.hint')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('keyword-find-input'), 'zzz');
    await waitFor(() => expect(screen.getByText('find.none')).toBeTruthy(), { timeout: 3000 });
  });

  test('a failed search says so', async () => {
    mockWorkspace.findKeyword = jest.fn(async () => null);
    await render(<KeywordFindModal onClose={() => undefined} onOpen={() => undefined} visible />);
    await waitFor(() => expect(screen.getByText('find.hint')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('keyword-find-input'), 'yyy');
    await waitFor(() => expect(screen.getByText('find.failed')).toBeTruthy(), { timeout: 3000 });
  });

  test('waits for a pause, lists the chats with counts and projects, and opens one at its message', async () => {
    mockWorkspace.findKeyword = jest.fn(async () => [{
      conversationId: 'conversation-a',
      messageCount: 2,
      latestMessageId: '42',
      latestMessageAt: '2026-09-23T02:00:00Z',
      snippet: 'The acid arrives Friday',
      projects: [{ projectId: 'project-1', name: 'HDG' }],
      items: [],
    }]);
    const onOpen = jest.fn();
    await render(<KeywordFindModal onClose={() => undefined} onOpen={onOpen} visible />);
    await waitFor(() => expect(screen.getByText('find.hint')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('keyword-find-input'), 'ac');
    fireEvent.changeText(screen.getByTestId('keyword-find-input'), 'acid');
    await waitFor(() => expect(screen.getByText('Administration Team')).toBeTruthy(), { timeout: 3000 });
    // Typing "ac" then "acid" within the pause asks once, for "acid".
    expect(mockWorkspace.findKeyword).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.findKeyword).toHaveBeenCalledWith('acid');
    expect(screen.getByText('find.messagesMany · find.project')).toBeTruthy();
    fireEvent.press(screen.getByText('Administration Team'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('conversation-a', '42'));
  });
});
