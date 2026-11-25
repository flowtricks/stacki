// Settings, loaded when it is first asked for. The dialog pulls in the code highlighter, every
// settings tab, the CMS and Studio setup screens: a large share of the first bundle for a dialog that
// is closed at launch. The start screen and the shell call `openAppSettings` from here, the host
// stays mounted in App.tsx, and the real module (Settings.tsx) arrives on the first request or when
// the renderer is idle, whichever is first (`preloadSettings`, src/main.tsx).
import { useEffect, useState, type ComponentProps } from 'react';
import type SettingsHost from './Settings';
import type { SettingsTab } from './settingsTab';

type SettingsModule = typeof import('./Settings');
type HostProps = ComponentProps<typeof SettingsHost>;

let loading: Promise<SettingsModule> | undefined = undefined;
// The request made before the module was mounted, delivered once it is (see LazySettings).
let pending: { readonly tab: SettingsTab | undefined } | undefined = undefined;
const mountedHosts = new Set<(module: SettingsModule) => void>();
let mounted: SettingsModule | undefined = undefined;

/** Fetches the Settings chunk ahead of the first open. */
export function preloadSettings(): Promise<SettingsModule> {
  if (loading === undefined) {
    loading = import('./Settings').then(
      (module) => module,
      (error: unknown) => {
        // A failed fetch is not remembered: the next open asks again.
        loading = undefined;
        throw error;
      },
    );
  }
  return loading;
}

/** Opens Settings on `tab`, or on the tab it was last left on. */
export function openAppSettings(tab?: SettingsTab): void {
  if (mounted !== undefined) {
    mounted.openAppSettings(tab);
    return;
  }
  pending = { tab };
  void preloadSettings().then((module) => {
    for (const host of mountedHosts) {
      host(module);
    }
  });
}

export default function LazySettings(props: HostProps) {
  const [module, setModule] = useState<SettingsModule | undefined>(mounted);
  useEffect(() => {
    mountedHosts.add(setModule);
    const unsubscribe = window.avb.onMenu('settings', () => {
      if (mounted === undefined) {
        openAppSettings(undefined);
      }
    });
    return () => {
      mountedHosts.delete(setModule);
      unsubscribe();
    };
  }, []);
  // Child effects run first, so the real dialog has registered its opener by now.
  useEffect(() => {
    if (module === undefined) {
      return;
    }
    mounted = module;
    if (pending !== undefined) {
      const request = pending;
      pending = undefined;
      module.openAppSettings(request.tab);
    }
  }, [module]);
  if (module === undefined) {
    return undefined;
  }
  const Settings = module.default;
  return <Settings {...props} />;
}
