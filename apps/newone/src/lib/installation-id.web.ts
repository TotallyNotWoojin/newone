import { createClientId } from '@/lib/client-id';

const INSTALLATION_KEY = 'newone.installation-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memoryId: string | null = null;

export async function getInstallationId() {
  if (memoryId) return memoryId;
  if (typeof window !== 'undefined') {
    const existing = window.localStorage.getItem(INSTALLATION_KEY);
    if (existing && UUID_PATTERN.test(existing)) {
      memoryId = existing;
      return existing;
    }
  }
  memoryId = createClientId();
  if (typeof window !== 'undefined') window.localStorage.setItem(INSTALLATION_KEY, memoryId);
  return memoryId;
}
