// Settings → Breakpoints: the breakpoints the preview bar jumps to, kept in the project's tracked `.stacki/breakpoints.json`
// (shared/properties/projectBreakpoints.ts) so Desktop and Studio read the same ones. One card per device, largest first, each
// led by the icon the preview bar uses for it: the name, the query it stands for (`Matches width < 64rem`, live as it is typed),
// and at the right the value field (rem, or px; a bare number is px) over the canvas width it resolves to (`1023px canvas`).
// Desktop is the full width and has no number.
//
// A value commits when its field loses focus or Enter is pressed, and saves at once; Escape puts the saved value back. An entry
// that is not a width, is out of the canvas's range, or is not smaller than the card above it is never written: the card says
// why under its field (the message names the card at fault) and keeps what was typed so it can be fixed. Reading the file never
// writes it: the file is created by the first edit.
import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  BREAKPOINT_KEYS,
  BREAKPOINT_LIMITS,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  checkedSettings,
  firstOutOfOrder,
  formatBreakpoint,
  parseBreakpointEntry,
  type BreakpointKey,
  type BreakpointSettings,
} from '../../../shared/properties/projectBreakpoints';
import { can } from '../../../shared/properties/projectRoles';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import type { IconProps } from '../../ui/Icons';
import { DesktopIcon, LaptopIcon, PhoneIcon, TabletIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import type { BreakpointSyncScan } from '../../../shared/properties/breakpointSyncPlan';
import { applyBreakpointSyncRequest, breakpointSyncAvailable, restoreBreakpointSyncRequest, scanBreakpointSyncRequest } from '../../ipc/breakpointSyncBridge';
import { BreakpointSyncDialog } from './BreakpointSyncDialog';
import { applyRequest, type CheckedPlaces } from '../../../shared/properties/breakpointSyncSelection';
import { SettingsNotice, SettingsSaveRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import './breakpointsSettings.css';

const LABELS: Readonly<Record<BreakpointKey, MessageKey>> = {
  laptop: 'settings.breakpoints.laptop',
  tablet: 'settings.breakpoints.tablet',
  phone: 'settings.breakpoints.phone',
};

// The preview bar's own icon components (preview/PreviewToolbar.tsx DEVICES), so a card and its button always match.
const ICONS: Readonly<Record<BreakpointKey | 'desktop', ComponentType<IconProps>>> = {
  desktop: DesktopIcon,
  laptop: LaptopIcon,
  tablet: TabletIcon,
  phone: PhoneIcon,
};

const ICON_SIZE_PX = 16;

type Drafts = Readonly<Record<BreakpointKey, string>>;

/** How long a scan may take before the dialog shows its skeleton rows instead of waiting for it. */
const SCAN_SLOW_MS = 250;

/** What the Undo list is told about a sync: a step that puts the files, and the number, back. */
export interface BreakpointSyncUndo {
  readonly label: string;
  readonly labelRef: ReturnType<typeof messageRef>;
  readonly undo: () => Promise<unknown>;
  readonly redo: () => Promise<unknown>;
}

interface SyncRun {
  readonly key: BreakpointKey;
  readonly before: BreakpointSettings;
  readonly after: BreakpointSettings;
  readonly scan: BreakpointSyncScan | undefined;
}

export function BreakpointsSettings({
  projectPath,
  onRecordUndo,
}: {
  readonly projectPath: string;
  readonly onRecordUndo?: ((command: BreakpointSyncUndo) => void) | undefined;
}) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const editable = can(role, 'settings:breakpoints');
  const { settings, state, save } = useProjectBreakpoints(projectPath);
  const indicator = useSaveIndicator();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(settings));
  const [run, setRun] = useState<SyncRun>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>();
  const scanSerial = useRef(0);
  const [saveProblem, setSaveProblem] = useState<{ readonly key: BreakpointKey; readonly message: string }>();
  // The saved values are the truth: an edit in another window or a pull puts them back in the fields.
  useEffect(() => {
    setDrafts(draftsOf(settings));
    setSaveProblem(undefined);
  }, [settings]);

  const commit = async (key: BreakpointKey): Promise<void> => {
    const entry = parseBreakpointEntry(drafts[key]);
    if (!entry.ok || draftProblem(key, drafts[key], settings, translate) !== undefined) {
      // The card already says why; nothing is written and what was typed stays to be fixed.
      return;
    }
    const checked = checkedSettings({ ...settings, [key]: entry.value });
    if (!checked.ok) {
      return;
    }
    if (breakpointsEqual(checked.value, settings)) {
      // The same boundary again is not an edit; the field only drops what was typed around it ("64 rem" back to "64rem").
      setDrafts(draftsOf(settings));
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setSaveProblem(undefined);
      void startSync(key, settings, checked.value);
    } else {
      setSaveProblem({ key, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  // After the number is saved, the project's media queries that still hold its old value are looked for; a dialog opens only when
  // there are some (or when the search is slow, with skeleton rows). Nothing is written until the person confirms.
  const startSync = async (key: BreakpointKey, before: BreakpointSettings, after: BreakpointSettings): Promise<void> => {
    if (!breakpointSyncAvailable()) {
      return;
    }
    scanSerial.current += 1;
    const serial = scanSerial.current;
    setSyncMessage(undefined);
    const slow = window.setTimeout(() => {
      if (scanSerial.current === serial) {
        setRun({ key, before, after, scan: undefined });
      }
    }, SCAN_SLOW_MS);
    const answer = await scanBreakpointSyncRequest(projectPath, { key, old: before[key], next: after[key] });
    window.clearTimeout(slow);
    if (scanSerial.current !== serial) {
      return;
    }
    if (answer.ok && answer.scan.files.length > 0) {
      setRun({ key, before, after, scan: answer.scan });
    } else {
      setRun(undefined);
    }
  };
  const apply = async (current: SyncRun, checkedPlaces: CheckedPlaces): Promise<void> => {
    if (current.scan === undefined) {
      return;
    }
    setSyncBusy(true);
    const result = await applyBreakpointSyncRequest(applyRequest(projectPath, current.key, current.scan, checkedPlaces));
    setSyncBusy(false);
    setRun(undefined);
    if (!result.ok) {
      setSyncMessage(translate('settings.breakpoints.sync.failed', { message: result.error ?? '' }));
      return;
    }
    const notes: string[] = [];
    if (result.places > 0) {
      notes.push(translate('settings.breakpoints.sync.done', { count: result.places }));
    }
    if (result.skipped.length > 0) {
      notes.push(translate('settings.breakpoints.sync.skippedFiles', { count: result.skipped.length }));
    }
    setSyncMessage(notes.length > 0 ? notes.join(' ') : undefined);
    const journalId = result.journalId;
    if (journalId !== undefined && onRecordUndo !== undefined) {
      onRecordUndo({
        label: translate('settings.breakpoints.sync.undoLabel'),
        labelRef: messageRef('settings.breakpoints.sync.undoLabel'),
        undo: async () => {
          await restoreBreakpointSyncRequest(projectPath, journalId, 'undo');
          await save(current.before);
        },
        redo: async () => {
          await restoreBreakpointSyncRequest(projectPath, journalId, 'redo');
          await save(current.after);
        },
      });
    }
  };

  if (state.kind === 'loading') {
    return (
      <section className="breakpoints-settings" role="status" aria-busy="true" aria-label={translate('settings.tab.breakpoints')}>
        {['desktop', ...BREAKPOINT_KEYS].map((key) => (
          <Skeleton key={key} height="72px" radius="12px" />
        ))}
      </section>
    );
  }
  return (
    <section className="breakpoints-settings" aria-label={translate('settings.tab.breakpoints')}>
      <SettingsSaveRow saving={indicator.state} />
      {syncMessage !== undefined && <SettingsNotice message={syncMessage} />}
      {state.kind === 'blocked' && <SettingsNotice message={translate('settings.breakpoints.error.file', { message: state.message })} />}
      <SettingsSection
        title={translate('settings.tab.breakpoints')}
        info={`${translate('settings.breakpoints.intro')} ${translate('settings.breakpoints.explain')}`}
      >
        <div className="breakpoints-cards">
          <div className="breakpoints-card" data-breakpoint="desktop">
            <span className="breakpoints-tile" aria-hidden="true">
              <ICONS.desktop size={ICON_SIZE_PX} />
            </span>
            <div className="breakpoints-text">
              <span className="breakpoints-name">{translate('settings.breakpoints.desktop')}</span>
            </div>
            <span className="breakpoints-pill">{translate('settings.breakpoints.desktopWidth')}</span>
          </div>
          {BREAKPOINT_KEYS.map((key) => {
            const Icon = ICONS[key];
            const problem = draftProblem(key, drafts[key], settings, translate) ?? (saveProblem?.key === key ? saveProblem.message : undefined);
            const typed = parseBreakpointEntry(drafts[key]);
            const shown = typed.ok ? typed.value : settings[key];
            return (
              <div key={key} className="breakpoints-card" data-breakpoint={key} data-invalid={problem === undefined ? undefined : ''}>
                <span className="breakpoints-tile" aria-hidden="true">
                  <Icon size={ICON_SIZE_PX} />
                </span>
                <div className="breakpoints-text">
                  <span className="breakpoints-name">{translate(LABELS[key])}</span>
                  <span className="breakpoints-query" id={`breakpoints-query-${key}`}>
                    {translate('settings.breakpoints.query', { condition: breakpointCondition(shown) })}
                  </span>
                </div>
                <div className="breakpoints-field">
                  <input
                    className="breakpoints-input"
                    type="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={drafts[key]}
                    disabled={!editable || state.kind === 'blocked'}
                    maxLength={BREAKPOINT_LIMITS.entryCharsMax}
                    aria-label={translate('settings.breakpoints.widthLabel', { device: translate(LABELS[key]) })}
                    aria-describedby={`breakpoints-query-${key}`}
                    aria-invalid={problem === undefined ? undefined : true}
                    onChange={(event) => setDrafts({ ...drafts, [key]: event.currentTarget.value })}
                    onBlur={() => void commit(key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      } else if (event.key === 'Escape') {
                        // Back to the saved value, without committing what was typed.
                        event.preventDefault();
                        event.stopPropagation();
                        setSaveProblem(undefined);
                        setDrafts((current) => ({ ...current, [key]: formatBreakpoint(settings[key]) }));
                      }
                    }}
                  />
                  <span className="breakpoints-canvas">{translate('settings.breakpoints.canvas', { width: canvasWidthPx(shown) })}</span>
                </div>
                {problem !== undefined && (
                  <p className="breakpoints-problem" role="alert">
                    {problem}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>
      {run !== undefined && (
        <BreakpointSyncDialog
          state={run.scan === undefined ? { kind: 'scanning' } : { kind: 'ready', scan: run.scan }}
          busy={syncBusy}
          onApply={(checkedPlaces) => void apply(run, checkedPlaces)}
          onSkip={() => {
            scanSerial.current += 1;
            setRun(undefined);
          }}
        />
      )}
    </section>
  );
}

function draftsOf(settings: BreakpointSettings): Drafts {
  return {
    laptop: formatBreakpoint(settings.laptop),
    tablet: formatBreakpoint(settings.tablet),
    phone: formatBreakpoint(settings.phone),
  };
}

// Why this card's typed value cannot be saved, or undefined when it can (or is the saved value untouched).
function draftProblem(key: BreakpointKey, draft: string, settings: BreakpointSettings, translate: Translator): string | undefined {
  if (draft === formatBreakpoint(settings[key])) {
    return undefined;
  }
  const entry = parseBreakpointEntry(draft);
  if (!entry.ok) {
    return entryProblem(entry.error.code, translate);
  }
  const next: BreakpointSettings = { ...settings, [key]: entry.value };
  const outOfOrder = firstOutOfOrder(next);
  return outOfOrder === undefined ? undefined : orderProblem(outOfOrder, next, translate);
}

function entryProblem(code: string, translate: Translator): string {
  if (code === 'breakpoints-pxWhole') {
    return translate('settings.breakpoints.error.pxWhole');
  }
  if (code === 'breakpoints-range') {
    return translate('settings.breakpoints.error.range', {
      minimum: `${BREAKPOINT_LIMITS.boundaryPxMin}px`,
      maximum: `${BREAKPOINT_LIMITS.boundaryPxMax}px`,
    });
  }
  return translate('settings.breakpoints.error.syntax');
}

// The card that is not smaller than the one above it, named, with the limit it has to stay under.
function orderProblem(row: BreakpointKey, next: BreakpointSettings, translate: Translator): string {
  const above: BreakpointKey = row === 'tablet' ? 'laptop' : 'tablet';
  return translate('settings.breakpoints.error.order', {
    row: translate(LABELS[row]),
    above: translate(LABELS[above]),
    limit: formatBreakpoint(next[above]),
  });
}
