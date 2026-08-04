// Metro selects the SecureStore-backed native installation identity.
// eslint-disable-next-line import/no-unresolved
import { secureStorage } from '@/lib/secure-storage';
import { createClientId } from '@/lib/client-id';

const INSTALLATION_KEY = 'newone.device.installation-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getInstallationId() {
  const existing = await secureStorage.getItem(INSTALLATION_KEY);
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const created = createClientId();
  await secureStorage.setItem(INSTALLATION_KEY, created);
  return created;
}
