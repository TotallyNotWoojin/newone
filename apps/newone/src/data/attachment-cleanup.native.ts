import { File } from 'expo-file-system';

export async function removeTemporaryAttachment(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Temporary-file cleanup is best effort and never changes the server's
    // attachment/quarantine result.
  }
}
