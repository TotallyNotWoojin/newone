import { useEffect } from 'react';

import { useWorkspace } from '@/state/workspace';

/**
 * A user's profile picture URL, requested on first use and refreshed by the
 * workspace before it expires. Lives outside the workspace module so screens
 * that mock the workspace in tests keep working: without the request function
 * or the URL map there is simply no picture and the initials show.
 */
export function useProfileAvatar(userId: string | null | undefined): string | undefined {
  const workspace = useWorkspace() as ReturnType<typeof useWorkspace> | undefined;
  const requestProfileAvatar = workspace?.requestProfileAvatar;
  useEffect(() => {
    if (userId && typeof requestProfileAvatar === 'function') requestProfileAvatar(userId);
  }, [requestProfileAvatar, userId]);
  return userId ? workspace?.profileAvatarUrls?.[userId] : undefined;
}
