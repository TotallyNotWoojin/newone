import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { clientStore } from '@/data/persistence/client-store';
import { isThemePreference, type ThemePreference } from '@/theme/scheme';

/**
 * Per-device reading and typing preferences. These are deliberately local
 * (not synced through the workspace): they describe how this phone shows and
 * sends messages, and they must work before any network round-trip.
 *
 * - translatedOnly: show only the translation in a bubble, with a per-message
 *   control to reveal the original.
 * - showOwnTranslations: under your own sent messages, show the translation
 *   the other side reads, in the same two lines as an incoming message.
 * - enterSends: the keyboard's return/enter key sends the message instead of
 *   inserting a newline (default on; a Settings toggle turns it off).
 * - notificationsPromptedAt: when the app first asked for notification
 *   permission, so the ask happens once at first launch, not on every start.
 * - theme: light or dark, or "system" to follow the phone's appearance
 *   setting (the default).
 */
export interface DevicePreferences {
  translatedOnly: boolean;
  showOwnTranslations: boolean;
  enterSends: boolean;
  notificationsPromptedAt: string | null;
  theme: ThemePreference;
}

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  translatedOnly: false,
  showOwnTranslations: false,
  enterSends: true,
  notificationsPromptedAt: null,
  theme: 'system',
};

// v3.3 starts everyone from the documented defaults. These live on the device,
// so a phone would otherwise carry a switch someone flipped months ago into a
// release where every account is new — "show only translations" in particular
// is off by default and had stayed on for whoever had once tried it.
const STORAGE_KEY = 'preferences.device.v2';

/**
 * The latest preferences, readable outside React. The workspace's translation
 * follow-up runs in a callback with no provider in scope and needs to know
 * whether a sender is waiting to see their own translation.
 */
let latestPreferences: DevicePreferences = DEFAULT_DEVICE_PREFERENCES;

export function currentDevicePreferences(): DevicePreferences {
  return latestPreferences;
}

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
      showOwnTranslations: typeof parsed.showOwnTranslations === 'boolean' ? parsed.showOwnTranslations : DEFAULT_DEVICE_PREFERENCES.showOwnTranslations,
      enterSends: typeof parsed.enterSends === 'boolean' ? parsed.enterSends : DEFAULT_DEVICE_PREFERENCES.enterSends,
      notificationsPromptedAt: typeof parsed.notificationsPromptedAt === 'string' ? parsed.notificationsPromptedAt : null,
      theme: isThemePreference(parsed.theme) ? parsed.theme : DEFAULT_DEVICE_PREFERENCES.theme,
    };
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

export function DevicePreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<DevicePreferences>(DEFAULT_DEVICE_PREFERENCES);
  const [ready, setReady] = useState(false);

  // Mirror the choice where code outside React can read it.
  useEffect(() => {
    latestPreferences = preferences;
  }, [preferences]);

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
