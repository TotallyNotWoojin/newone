import { jest } from '@jest/globals';

/** The workspace members the projects, 찾기 and summary-readiness features read, idle by default. */
export function projectWorkspaceFields() {
  return {
    projectRevisions: {} as Record<string, number>,
    loadConversationProjects: jest.fn(async (..._args: unknown[]) => null as unknown),
    runProjectCommand: jest.fn(async (..._args: unknown[]) => null as unknown),
    loadSummaryReadiness: jest.fn(async (..._args: unknown[]) => null as unknown),
    findKeyword: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
    exportSummaryFile: jest.fn(async (..._args: unknown[]) => null as unknown),
    downloadAttachmentById: jest.fn(async (..._args: unknown[]) => true),
  };
}
