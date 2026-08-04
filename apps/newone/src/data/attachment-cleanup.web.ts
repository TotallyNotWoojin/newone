export async function removeTemporaryAttachment(uri: string) {
  if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
}
