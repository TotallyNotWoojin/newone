import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import type { AppLocale, MessageKey } from '@/i18n/catalog';
import { catalogs } from '@/i18n/catalog';
// Metro selects the safe platform adapter.
// eslint-disable-next-line import/no-unresolved
import { clientStore } from '@/data/persistence/client-store';

const LOCALE_KEY = 'preferences.ui-locale';

function deviceLocale(): AppLocale {
  const base = Intl.DateTimeFormat().resolvedOptions().locale.toLocaleLowerCase().split('-')[0];
  return base === 'ko' || base === 'es' ? base : 'en';
}

interface I18nValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: PropsWithChildren) {
  // Static web HTML is generated without the user's browser locale. Start web
  // hydration from the same language as the export, then restore the device or
  // encrypted preference after React owns the tree. Native has no SSR pass.
  const [locale, setLocaleState] = useState<AppLocale>(() => (
    Platform.OS === 'web' ? 'en' : deviceLocale()
  ));

  useEffect(() => {
    let active = true;
    void clientStore.initialize()
      .then(async () => {
        const saved = await clientStore.getCache(LOCALE_KEY);
        if (!active) return;
        setLocaleState(saved === 'en' || saved === 'ko' || saved === 'es' ? saved : deviceLocale());
      })
      .catch(() => {
        // The app still follows the device locale when secure persistence is unavailable.
        if (active) setLocaleState(deviceLocale());
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale: (nextLocale) => {
        setLocaleState(nextLocale);
        void clientStore.putCache(LOCALE_KEY, nextLocale).catch(() => {
          // Do not fall back to plaintext browser storage.
        });
      },
      t: (key) => catalogs[locale][key],
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
