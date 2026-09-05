import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { clientStore } from '@/data/persistence/client-store';

/**
 * Per-device reading and typing preferences. These are deliberately local
 * (not synced through the workspace): they describe how this phone shows and
 * sends messages, and they must work before any network round-trip.
 *
 * - translatedOnly: show only the translation in a bubble, with a per-message
 *   control to reveal the original.
 * - enterSends: the keyboard's return/enter key sends the message instead of
 *   inserting a newline (default on; a Settings toggle turns it off).
 * - notificationsPromptedAt: when the app first asked for notification
 *   permission, so the ask happens once at first launch, not on every start.
 */
export interface DevicePreferences {
  translatedOnly: boolean;
  enterSends: boolean;
  notificationsPromptedAt: string | null;
}

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  translatedOnly: false,
  enterSends: true,
  notificationsPromptedAt: null,
};

const STORAGE_KEY = 'preferences.device.v1';

interface DevicePreferencesValue {
  preferences: DevicePreferences;
  ready: boolean;
  setPreference: <K extends keyof DevicePreferences>(key: K, value: DevicePreferences[K]) => void;
}

const DevicePreferencesContext = createContext<DevicePreferencesValue>({
  preferences: DEFAULT_DEVICE_PREFERENCES,
  ready: false,
  setPreference: () => undefined,
});

export function parseDevicePreferences(raw: string | null | undefined): DevicePreferences {
  if (!raw) return DEFAULT_DEVICE_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof DevicePreferences, unknown>>;
    return {
      translatedOnly: typeof parsed.translatedOnly === 'boolean' ? parsed.translatedOnly : DEFAULT_DEVICE_PREFERENCES.translatedOnly,
      enterSends: typeof parsed.enterSends === 'boolean' ? parsed.enterSends : DEFAULT_DEVICE_PREFERENCES.enterSends,
      notificationsPromptedAt: typeof parsed.notificationsPromptedAt === 'string' ? parsed.notificationsPromptedAt : null,
    };
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

export function DevicePreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<DevicePreferences>(DEFAULT_DEVICE_PREFERENCES);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void clientStore.initialize()
      .then(() => clientStore.getCache(STORAGE_KEY))
      .then((raw) => {
        if (!active) return;
        setPreferences(parseDevicePreferences(raw));
      })
      .catch(() => {
        // Defaults are fine when the store is unavailable; the next write wins.
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback<DevicePreferencesValue['setPreference']>((key, value) => {
    setPreferences((current) => {
      const next = { ...current, [key]: value };
      void clientStore.putCache(STORAGE_KEY, JSON.stringify(next)).catch(() => {
        // Keep the in-memory value; persistence retries on the next change.
      });
      return next;
    });
  }, []);

  const value = useMemo(() => ({ preferences, ready, setPreference }), [preferences, ready, setPreference]);
  return (
    <DevicePreferencesContext.Provider value={value}>
      {children}
    </DevicePreferencesContext.Provider>
  );
}

export function useDevicePreferences(): DevicePreferencesValue {
  return useContext(DevicePreferencesContext);
}
