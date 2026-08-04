import { randomUUID } from 'expo-crypto';

export function createClientId() {
  return randomUUID();
}
