import { useRouter } from 'expo-router';
import { useEffect, type ReactElement } from 'react';

import { isPersonalRealm } from '@/constants/personal-realm';
import { useWorkspace } from '@/state/workspace';

/**
 * A route that only a workplace account may open.
 *
 * `app.json` sets `web.output: "static"`, so every route is also a file:
 * `dist/updates.html` and `dist/handoffs.html` are addressable by anyone who
 * types the URL. Those two screens had no realm check at all and rendered an
 * empty workplace surface to a consumer instead of refusing, which is a weaker
 * posture than `/admin`, whose capability gate has always turned a consumer
 * away.
 *
 * The screen is passed as an element rather than rendered by the caller, so a
 * personal-realm account never mounts it: none of its hooks run, none of its
 * loaders fire, and nothing workplace-shaped is on screen for a frame before
 * the redirect lands. While the realm is still unknown (bootstrap in flight,
 * `organizationId` null) the screen renders its own loading state as before --
 * only a confirmed personal realm redirects.
 */
export function WorkplaceOnlyRoute({ screen }: { screen: ReactElement }): ReactElement | null {
  const router = useRouter();
  const workspace = useWorkspace();
  const consumer = isPersonalRealm(workspace.organizationId);

  useEffect(() => {
    if (consumer) router.replace('/');
  }, [consumer, router]);

  return consumer ? null : screen;
}
