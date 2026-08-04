export function edgeFunctionForPath(path: string): 'newone-auth' | 'newone-read' | 'newone-api' | null;

export function resolveApiUrl(input: {
  path: string;
  platform: string;
  apiBase: string | null;
  supabaseUrl: string | null;
}): string | null;

export function supabaseProjectOrigin(value: unknown): string | null;

export function resolveStorageSignedUrl(input: {
  signedUrl: unknown;
  supabaseUrl: unknown;
  action: 'upload' | 'download';
}): string | null;

export function directEdgeRequestHeaders(input: {
  platform: string;
  publishableKey: string | null;
  accessToken?: string;
}): Record<string, string> | null;
