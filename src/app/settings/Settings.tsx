// Settings: a sidebar of tabs beside the chosen tab's page. The page has a
// fixed header (its title and the close button) and a scroll area that fades
// an edge only while there is more to scroll past it, so a row is never cut in
// half against the chrome. Every tab saves each change as it is made, with a
// "Saved" indicator (SettingsLayout.tsx), so there is nothing to lose on close.
import { ErrorToast } from '../../ui/ErrorToast';
import { CmsConnections } from '../../features/cmsConnections/CmsConnections';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import Popup from '../../ui/Popup';
import StudioSetup from '../../features/studioSetup/StudioSetup';
import { cleanError } from '../../lib/cleanError';
import { readPreferences, savePreference } from './preferencesBridge';
import './settings.css';
import { CloseIcon } from '../../ui/Icons';
import { Switch } from '../../ui/Switch';
import { useScrollEdges } from '../../ui/useScrollEdges';
import { FolderSettings } from './FolderSettings';
import { InstructionsSettings } from './InstructionsSettings';
import { AuditsSettings } from './AuditsSettings';
import { SETTINGS_TABS, loadSettingsTab, saveSettingsTab, settingsTabAfterKey, type SettingsTab } from './settingsTab';
import { RolesSettings } from './RolesSettings';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { canSettingsTab } from '../../lib/roleAccess';
import { FeatureIcon } from '../featureIcons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { LanguageSetting } from './LanguageSetting';
import { SettingsEmpty, SettingsIntro, SettingsRow, SettingsSection, useSaveIndicator } from './SettingsLayout';

interface Props {
  readonly projectPath: string | undefined;
  readonly previewURL: string | undefined;
  /** Where Astro reads pages and the astro.config that says so, for the Folders tab. */
  readonly pages?: { readonly folder: string; readonly configFile: string | undefined };
  /** Opens a project file in the code panel (the Folders tab's "Open …" links); Settings closes first. */
  readonly onOpenFile?: (rel: string) => void;
}

// Who opens Settings besides the File menu: the title bar's gear on Windows and
// Linux, whose custom title bar has no menu bar to hold File > Settings, and the
// CMS rail's "connect" action, which opens straight onto CMS connections.
const settingsOpeners = new Set<(tab: SettingsTab | undefined) => void>();

export type { SettingsTab } from './settingsTab';

/** Opens Settings, as File > Settings… does: on `tab`, or on the tab it was
 * last left on when the caller has no reason to pick one. */
export function openAppSettings(tab?: SettingsTab): void {
  assert(settingsOpeners.size <= 1, 'One Settings dialog is mounted');
  for (const open of settingsOpeners) {
    open(tab);
  }
}

export default function Settings(props: Props) {
  const [open, setOpen] = useState<SettingsTab | undefined>(undefined);
  // An open dialog switches tabs itself, through its leave guard, so a request
  // to open Settings never remounts it and drops an unsaved draft.
  const switchTab = useRef<((tab: SettingsTab) => void) | undefined>(undefined);
  useEffect(() => {
    const opener = (tab: SettingsTab | undefined) => {
      const mounted = switchTab.current;
      if (mounted === undefined) {
        setOpen(tab ?? loadSettingsTab());
      } else if (tab !== undefined) {
        mounted(tab);
      }
    };
    settingsOpeners.add(opener);
    const unsubscribe = window.avb.onMenu('settings', () => opener(undefined));
    return () => {
      settingsOpeners.delete(opener);
      unsubscribe();
    };
  }, []);
  const registerSwitch = useCallback((next: ((tab: SettingsTab) => void) | undefined) => {
    switchTab.current = next;
  }, []);
  return open ? <SettingsDialog {...props} tab={open} registerSwitch={registerSwitch} onClose={() => setOpen(undefined)} /> : undefined;
}

const TAB_LABELS: Readonly<Record<SettingsTab, MessageKey>> = {
  editor: 'settings.tab.editor',
  folders: 'settings.tab.folders',
  cms: 'settings.tab.cms',
  studio: 'settings.tab.studio',
  instructions: 'settings.tab.instructions',
  audits: 'settings.tab.audits',
  roles: 'settings.tab.roles',
};

function TabIcon(props: { readonly tab: SettingsTab }) {
  return <FeatureIcon feature={`settings:${props.tab}`} size={14} />;
}

interface DialogProps extends Props {
  readonly tab: SettingsTab;
  /** Lets an opener switch the open dialog's tab instead of remounting it. */
  readonly registerSwitch: (switchTab: ((tab: SettingsTab) => void) | undefined) => void;
  readonly onClose: () => void;
}

function SettingsDialog(props: DialogProps) {
  const translate = useTranslate();
  // Tabs the project's role hides are left out; a hidden tab opens on the first shown one.
  const role = useCurrentRole();
  const shown = SETTINGS_TABS.filter((item) => canSettingsTab(role, item));
  const [chosen, setChosen] = useState<SettingsTab>(props.tab);
  const tab = shown.includes(chosen) ? chosen : (shown[0] ?? 'roles');
  const tabButtons = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const scroll = useRef<HTMLDivElement>(null);
  const { edges, measure } = useScrollEdges(scroll);
  const show = useCallback((next: SettingsTab) => {
    setChosen(next);
    saveSettingsTab(next);
  }, []);
  // A new tab starts at its top, and its height decides the fades.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element !== null) {
      element.scrollTop = 0;
    }
    measure();
  }, [tab, measure]);
  const { registerSwitch } = props;
  useEffect(() => {
    registerSwitch(show);
    return () => registerSwitch(undefined);
  }, [registerSwitch, show]);

  return (
    <Popup className="app-settings" labelledBy="app-settings-title" onClose={props.onClose}>
      {({ close }) => (
        <div className="app-settings-layout">
          <nav className="app-settings-sidebar" aria-label={translate('settings.title')}>
            <h2 id="app-settings-title">{translate('settings.title')}</h2>
            <div
              className="app-settings-tabs"
              role="tablist"
              aria-label={translate('settings.sections')}
              aria-orientation="vertical"
              onKeyDown={(event) => {
                const next = settingsTabAfterKey(tab, event.key, shown);
                if (next !== undefined) {
                  event.preventDefault();
                  show(next);
                  tabButtons.current.get(next)?.focus();
                }
              }}
            >
              {shown.map((item) => (
                <button
                  key={item}
                  ref={(element) => {
                    if (element) {
                      tabButtons.current.set(item, element);
                    } else {
                      tabButtons.current.delete(item);
                    }
                  }}
                  type="button"
                  role="tab"
                  id={`app-settings-tab-${item}`}
                  aria-selected={item === tab}
                  aria-controls={`app-settings-panel-${item}`}
                  tabIndex={item === tab ? 0 : -1}
                  onClick={() => show(item)}
                >
                  <TabIcon tab={item} />
                  <span>{translate(TAB_LABELS[item])}</span>
                </button>
              ))}
            </div>
          </nav>
          <div className="app-settings-main">
            <header className="app-settings-header">
              <h3>{translate(TAB_LABELS[tab])}</h3>
              <button type="button" className="ghost app-settings-close" aria-label={translate('settings.close')} onClick={close}>
                <CloseIcon size={14} />
              </button>
            </header>
            <div ref={scroll} className="app-settings-scroll" data-edge-top={edges.top} data-edge-bottom={edges.bottom}>
              <div className="app-settings-content">
                {shown.map((item) => (
                  <div
                    key={item}
                    className="app-settings-panel"
                    role="tabpanel"
                    id={`app-settings-panel-${item}`}
                    aria-labelledby={`app-settings-tab-${item}`}
                    hidden={item !== tab}
                  >
                    <SettingsPanel {...props} tab={item} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Popup>
  );
}

function SettingsPanel(props: Props & { readonly tab: SettingsTab; readonly onClose: () => void }) {
  const translate = useTranslate();
  const icon = <FeatureIcon feature={`settings:${props.tab}`} size={20} />;
  switch (props.tab) {
    case 'editor':
      return <Preferences />;
    case 'folders':
      return props.projectPath ? (
        <FolderSettings
          key={`folders:${props.projectPath}`}
          projectPath={props.projectPath}
          {...(props.pages === undefined ? {} : { pages: props.pages })}
          {...(props.onOpenFile === undefined ? {} : { onOpenFile: openAfterClosing(props.onClose, props.onOpenFile) })}
        />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.folders')}</SettingsEmpty>
      );
    case 'cms':
      return props.projectPath ? (
        <CmsConnections key={`cms:${props.projectPath}`} projectPath={props.projectPath} />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.cms')}</SettingsEmpty>
      );
    case 'studio':
      return props.projectPath ? (
        <StudioSetup key={props.projectPath} projectPath={props.projectPath} previewURL={props.previewURL} onClose={props.onClose} />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.studio')}</SettingsEmpty>
      );
    case 'instructions':
      return props.projectPath ? (
        <InstructionsSettings key={`instructions:${props.projectPath}`} projectPath={props.projectPath} />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.instructions')}</SettingsEmpty>
      );
    case 'audits':
      return props.projectPath ? (
        <AuditsSettings key={`audits:${props.projectPath}`} projectPath={props.projectPath} />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.audits')}</SettingsEmpty>
      );
    case 'roles':
      return props.projectPath ? (
        <RolesSettings key={`roles:${props.projectPath}`} projectPath={props.projectPath} />
      ) : (
        <SettingsEmpty icon={icon}>{translate('settings.empty.roles')}</SettingsEmpty>
      );
    default: {
      const exhaustive: never = props.tab;
      return exhaustive;
    }
  }
}

// The code panel opens behind the modal, so Settings closes before it does.
function openAfterClosing(close: () => void, open: (rel: string) => void): (rel: string) => void {
  return (rel) => {
    close();
    open(rel);
  };
}

function usePreferences() {
  const translate = useTranslate();
  const [value, setValue] = useState<Awaited<ReturnType<typeof readPreferences>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const indicator = useSaveIndicator();
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
      const result = await indicator.track(savePreference(input));
      setValue(result);
      if (!result.saved) {
        setError(translate('settings.editor.saveFailed'));
      }
    } catch (failure: unknown) {
      setError(cleanError(failure));
    } finally {
      setBusy(false);
    }
  };
  return { value, busy, error, change, saving: indicator.state };
}

// Editor settings save each switch as it flips: each is safe to apply alone.
function Preferences() {
  const translate = useTranslate();
  const { value, busy, error, change, saving } = usePreferences();
  return (
    <section className="app-preferences" aria-label={translate('settings.editor.preferences')}>
      <SettingsIntro saving={saving}>{translate('settings.editor.intro')}</SettingsIntro>
      <SettingsSection title={translate('settings.editor.section.general')}>
        <LanguageSetting />
        <PreferenceToggle
          label={translate('settings.editor.sound.label')}
          description={translate('settings.editor.sound.description')}
          checked={value?.sound ?? false}
          disabled={!value || busy}
          onToggle={() => void change({ setting: 'sound', enabled: !value?.sound })}
        />
      </SettingsSection>
      <SettingsSection title={translate('settings.editor.section.ai')}>
        <PreferenceToggle
          label={translate('settings.editor.ai.askBeforeTrust.label')}
          description={translate('settings.editor.ai.askBeforeTrust.description')}
          checked={value?.aiAskBeforeTrust ?? false}
          disabled={!value || busy}
          onToggle={() => void change({ setting: 'aiAskBeforeTrust', enabled: !value?.aiAskBeforeTrust })}
        />
      </SettingsSection>
      <SettingsSection title={translate('settings.editor.section.privacy')}>
        <PreferenceToggle
          label={translate('settings.editor.privacy.usageCounts.label')}
          description={translate('settings.editor.privacy.usageCounts.description')}
          checked={value?.usageCountsEnabled ?? false}
          disabled={!value || busy}
          onToggle={() =>
            void change({
              setting: 'usageCountsEnabled',
              enabled: !value?.usageCountsEnabled,
            })
          }
        />
        <PreferenceToggle
          label={translate('settings.editor.privacy.hideDetails.label')}
          description={translate('settings.editor.privacy.hideDetails.description')}
          checked={value?.appsPersonHidden ?? false}
          disabled={!value || busy}
          onToggle={() => void change({ setting: 'appsPersonHidden', enabled: !value?.appsPersonHidden })}
        />
      </SettingsSection>
      {!value && !error && (
        <p className="app-settings-status" role="status">
          {translate('settings.editor.loading')}
        </p>
      )}
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
  const descriptionId = useId();
  return (
    <SettingsRow label={props.label} description={props.description} descriptionId={descriptionId}>
      <Switch label={props.label} checked={props.checked} disabled={props.disabled} describedBy={descriptionId} onToggle={props.onToggle} />
    </SettingsRow>
  );
}
