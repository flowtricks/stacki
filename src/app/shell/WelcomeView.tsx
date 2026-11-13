// The start screen, before a project is open, with the title bar button it shares with the
// editor shell. Kept out of AppShell.tsx on purpose: this is what a cold start paints, and the
// shell (every panel, the code editor, the style engine) loads behind it (docs/startup.md).
import type { AppView } from '../App';
import { ToastStack } from '../../features/notifications/ToastStack';
import WelcomeScreen from '../../features/welcome/WelcomeScreen';
import { ConfirmHost } from '../../ui/ConfirmDialog';
import { GearIcon } from '../../ui/Icons';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { openAppSettings } from '../settings/LazySettings';
import { BusyOverlay } from './BusyOverlay';

export function WelcomeView({ app }: { readonly app: AppView }) {
  // The welcome mode floats the title bar over the start screen so the
  // interactive backdrop runs edge to edge, behind the window controls.
  return (
    <div className="app welcome-mode">
      <div className="titlebar">
        <span className="spacer" />
        <SettingsButton />
      </div>
      <WelcomeScreen onOpen={app.onOpenProject} showToast={app.showToast} />
      {app.busy && <BusyOverlay message={app.busy} />}
      <ToastStack notices={app.notices} dismiss={app.dismissToast} />
      <ConfirmHost />
    </div>
  );
}

// Settings, where the platform has no menu bar to hold File > Settings…: Windows
// draws its own title bar (no menu bar), and Linux may hide it. On macOS the menu
// bar is always there, so the button would only repeat it.
export function SettingsButton() {
  const translate = useTranslate();
  const platform = currentDesktopPlatform();
  if (platform === 'darwin') {
    return undefined;
  }
  return (
    <button
      className="titlebar-btn"
      title={translate('rail.withShortcut', { label: translate('rail.settings'), shortcut: shortcutLabel(',', 'primary', platform) })}
      aria-label={translate('rail.settings')}
      onClick={() => openAppSettings()}
    >
      <GearIcon size={14} />
    </button>
  );
}
