import { ErrorToast } from '../../ui/ErrorToast';
import { CmsConnections } from '../../features/cmsConnections/CmsConnections';
import { useEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import StudioSetup from '../../features/studioSetup/StudioSetup';
import { cleanError } from '../../lib/cleanError';
import { readPreferences, savePreference } from './preferencesBridge';
import './settings.css';
import { InfoLabel } from '../../ui/InfoLabel';
import { assert } from '../../../shared/core/assert';

interface Props {
  readonly projectPath: string | undefined;
  readonly previewURL: string | undefined;
}

// Who opens Settings besides the File menu: the title bar's gear on Windows and
// Linux, whose custom title bar has no menu bar to hold File > Settings.
const settingsOpeners = new Set<(section: SettingsSection) => void>();

/** Where Settings opens: at the top, or scrolled to the project's CMS connections. */
export type SettingsSection = 'top' | 'cms';

/** Opens Settings, as File > Settings… does, at `section`. */
export function openAppSettings(section: SettingsSection = 'top'): void {
  assert(settingsOpeners.size <= 1, 'One Settings dialog is mounted');
  for (const open of settingsOpeners) {
    open(section);
  }
}

export default function Settings(props: Props) {
  const [open, setOpen] = useState<SettingsSection | undefined>(undefined);
  useEffect(() => window.avb.onMenu('settings', () => setOpen('top')), []);
  useEffect(() => {
    const opener = (section: SettingsSection) => setOpen(section);
    settingsOpeners.add(opener);
    return () => {
      settingsOpeners.delete(opener);
    };
  }, []);
  return open ? (
    <SettingsDialog {...props} section={open} onClose={() => setOpen(undefined)} />
  ) : undefined;
}

function SettingsDialog(
  props: Props & { readonly section: SettingsSection; readonly onClose: () => void },
) {
  const cmsSection = useRef<HTMLDivElement>(null);
  // Opened to add a CMS connection: that section is what the person came for.
  useEffect(() => {
    if (props.section === 'cms') {
      cmsSection.current?.scrollIntoView({ block: 'start' });
    }
  }, [props.section]);
  return (
    <Popup className="app-settings" labelledBy="app-settings-title" onClose={props.onClose}>
      {({ close }) => (
        <>
          <header>
            <h2 id="app-settings-title">Settings</h2>
            <button aria-label="Close settings" onClick={close}>
              ×
            </button>
          </header>
          <div className="app-settings-content">
            <Preferences />
            {props.projectPath && (
              <div ref={cmsSection}>
                <CmsConnections key={`cms:${props.projectPath}`} projectPath={props.projectPath} />
              </div>
            )}
            {props.projectPath ? (
              <StudioSetup
                key={props.projectPath}
                projectPath={props.projectPath}
                previewURL={props.previewURL}
                onClose={props.onClose}
              />
            ) : (
              <p>Open a project to add Stacki Studio.</p>
            )}
          </div>
          <footer>
            <button onClick={close}>Done</button>
          </footer>
        </>
      )}
    </Popup>
  );
}

function usePreferences() {
  const [value, setValue] = useState<Awaited<ReturnType<typeof readPreferences>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void readPreferences().then(
      (result) => {
        if (active) {
          setValue(result);
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(cleanError(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const change = async (input: Parameters<typeof savePreference>[0]) => {
    setBusy(true);
    setError('');
    try {
      const result = await savePreference(input);
      setValue(result);
      if (!result.saved) {
        setError('Applied for this session, but could not save. Check disk space and try again.');
      }
    } catch (failure: unknown) {
      setError(cleanError(failure));
    } finally {
      setBusy(false);
    }
  };
  return { value, busy, error, change };
}

function Preferences() {
  const { value, busy, error, change } = usePreferences();
  return (
    <section className="app-preferences" aria-label="App preferences">
      <PreferenceToggle
        label="Interface sounds"
        description="Play subtle sounds as you use the editor."
        checked={value?.sound ?? false}
        disabled={!value || busy}
        onToggle={() => void change({ setting: 'sound', enabled: !value?.sound })}
      />
      <PreferenceToggle
        label="Anonymous usage counts"
        description={
          'Send one count on days you open a project. No project names, file contents, ' +
          'device identifier, or activity history are sent. Daily totals are kept on ' +
          'Cloudflare for up to 366 days. Its network sees your connection IP; ' +
          'the usage database does not store it.'
        }
        checked={value?.usageCountsEnabled ?? false}
        disabled={!value || busy}
        onToggle={() =>
          void change({
            setting: 'usageCountsEnabled',
            enabled: !value?.usageCountsEnabled,
          })
        }
      />
      {!value && !error && <p role="status">Loading preferences…</p>}
      {error && <ErrorToast message={error} />}
    </section>
  );
}

function PreferenceToggle(props: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="app-preference-row">
      <InfoLabel label={props.label} description={props.description} />
      <button
        type="button"
        className="app-preference-toggle"
        role="switch"
        aria-label={props.label}
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={props.onToggle}
      >
        <span />
      </button>
    </div>
  );
}
