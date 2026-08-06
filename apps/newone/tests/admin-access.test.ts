import { describe, expect, test } from '@jest/globals';

import {
  ADMIN_SURFACE_CAPABILITIES,
  canAccessAdminSurface,
} from '@/features/admin/admin-access';

describe('admin surface authorization', () => {
  test('denies an account with no privileged capabilities', () => {
    expect(canAccessAdminSurface([])).toBe(false);
    expect(canAccessAdminSurface(['communications.publish', 'handoff.manage'])).toBe(false);
  });

  test.each(ADMIN_SURFACE_CAPABILITIES)(
    'allows the admin surface for %s',
    (capability) => {
      expect(canAccessAdminSurface(['communications.publish', capability])).toBe(true);
    },
  );

  test('keeps the privileged capability inventory unique', () => {
    expect(new Set(ADMIN_SURFACE_CAPABILITIES).size).toBe(ADMIN_SURFACE_CAPABILITIES.length);
  });
});
