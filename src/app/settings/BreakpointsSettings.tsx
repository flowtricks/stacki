// Settings → Breakpoints: the breakpoints the preview bar jumps to, kept in the project's tracked `.stacki/breakpoints.json`
// (shared/properties/projectBreakpoints.ts) so Desktop and Studio read the same ones. One card per breakpoint in the bar's order: the
// wider ones (`width >= X`), Desktop (full width, fixed), then the narrower ones (`width < X`), each led by the icon the bar draws
// for it, with its name, the query it stands for (live as it is typed), the value field (rem, or px; a bare number is px) over the
// canvas width it resolves to, and a remove button. "Add breakpoint" opens one more card to fill in: wider or narrower, a name, a value.
//
// A value commits when its field loses focus or Enter is pressed, and saves at once; Escape puts the saved value back. An entry that is
// not a width, is out of the canvas's range, or does not fit between its neighbours is never written: the card says why under its
// field and keeps what was typed. Removing a breakpoint never edits the project's CSS; one with remembered synced queries asks first.
// Reading the file never writes it: the file is created by the first edit.
import { useEffect, useRef, useState } from 'react';
import {
  BREAKPOINT_LIMITS,
  DESKTOP_ID,
  boundaryPx,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  checkedConfig,
  conflictAt,
  desktopBlocker,
  desktopFramePx,
  directionOf,
  formatBreakpoint,
  isBreakpointName,
  isBuiltinBreakpointId,
  nextBreakpointId,
  parseBreakpointEntry,
  resolveBreakpoints,
  uniqueBreakpointName,
  withBreakpointAdded,
  withBreakpointName,
  withBreakpointRemoved,
  withBreakpointSetting,
  withDesktop,
  withSettingInPlace,
  type Breakpoint,
  type BreakpointConfig,
  type BreakpointDirection,
  type BreakpointList,
} from '../../../shared/properties/projectBreakpoints';
import { can } from '../../../shared/properties/projectRoles';
import { entryOf, parseBreakpointSyncSource } from '../../../shared/properties/breakpointSyncRecord';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import { readMetadata } from '../../ipc/projectMetadataBridge';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { DesktopIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import type { BreakpointSyncScan } from '../../../shared/properties/breakpointSyncPlan';
import { applyBreakpointSyncRequest, breakpointSyncAvailable, restoreBreakpointSyncRequest, scanBreakpointSyncRequest } from '../../ipc/breakpointSyncBridge';
import { deviceIconComponent } from '../../features/preview/deviceIcons';
import { iconFor, type DeviceIconKind } from '../../features/preview/breakpointDevices';
import { breakpointLabel } from '../../lib/breakpointLabel';
import { BreakpointSyncDialog } from './BreakpointSyncDialog';
import { BreakpointUsageLine, BreakpointUsageList, hasUsage } from './BreakpointUsage';
import { BreakpointAddCard, type AddDraft } from './BreakpointAddCard';
import { useBreakpointUsage } from './useBreakpointUsage';
import { applyRequest, type CheckedPlaces } from '../../../shared/properties/breakpointSyncSelection';
import { SettingsNotice, SettingsSaveRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import './breakpointsSettings.css';

const ICON_SIZE_PX = 16;

/** How long a scan may take before the dialog shows its skeleton rows instead of waiting for it. */
const SCAN_SLOW_MS = 250;

/** What the Undo list is told about a change to the breakpoints: a step that puts the list (and any synced files) back. */
export interface BreakpointSyncUndo {
  readonly label: string;
  readonly labelRef: ReturnType<typeof messageRef>;
  readonly undo: () => Promise<unknown>;
  readonly redo: () => Promise<unknown>;
}

interface SyncRun {
  readonly id: string;
  readonly before: BreakpointConfig;
  readonly after: BreakpointConfig;
  readonly scan: BreakpointSyncScan | undefined;
}

type Drafts = Readonly<Record<string, string>>;

const DEFAULT_NAMES: Readonly<Record<BreakpointDirection, readonly MessageKey[]>> = {
  up: ['settings.breakpoints.defaultName.up0', 'settings.breakpoints.defaultName.up1', 'settings.breakpoints.defaultName.up2'],
  down: ['settings.breakpoints.defaultName.down0', 'settings.breakpoints.defaultName.down1', 'settings.breakpoints.defaultName.down2'],
};

export function BreakpointsSettings({
  projectPath,
  onRecordUndo,
  onOpenFile,
}: {
  readonly projectPath: string;
  readonly onRecordUndo?: ((command: BreakpointSyncUndo) => void) | undefined;
  /** Opens a project file in the Code panel (the used-in list links to it). */
  readonly onOpenFile?: ((rel: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const editable = can(role, 'settings:breakpoints');
  const { config, list, resolved, state, save } = useProjectBreakpoints(projectPath);
  const indicator = useSaveIndicator();
  const usage = useBreakpointUsage(projectPath, list);
  const [usageOpen, setUsageOpen] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(config));
  const [names, setNames] = useState<Drafts>(() => namesOf(list, translate));
  const [adding, setAdding] = useState<AddDraft>();
  const [run, setRun] = useState<SyncRun>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>();
  const scanSerial = useRef(0);
  const [saveProblem, setSaveProblem] = useState<{ readonly id: string; readonly message: string }>();
  // The saved list is the truth: an edit in another window or a pull puts it back in the fields.
  useEffect(() => {
    setDrafts(draftsOf(config));
    setNames(namesOf(list, translate));
    setSaveProblem(undefined);
  }, [config, list, translate]);

  const label = (breakpoint: Breakpoint): string => breakpointLabel(breakpoint, translate);
  const record = (before: BreakpointConfig, after: BreakpointConfig, name: string): void => {
    onRecordUndo?.({
      label: name,
      labelRef: messageRef('settings.breakpoints.undoLabel'),
      undo: async () => void (await save(before)),
      redo: async () => void (await save(after)),
    });
  };

  const commitValue = async (id: string): Promise<void> => {
    const draft = drafts[id] ?? '';
    const entry = parseBreakpointEntry(draft);
    if (!entry.ok) {
      return;
    }
    if (id === DESKTOP_ID) {
      return commitDesktop(entry.value, draft);
    }
    const current = list.find((breakpoint) => breakpoint.id === id);
    if (current === undefined || valueProblem(config, id, draft, translate) !== undefined) {
      // The card already says why; nothing is written and what was typed stays to be fixed.
      return;
    }
    const checked = checkedConfig(withBreakpointSetting(config, id, entry.value));
    if (!checked.ok) {
      return;
    }
    if (breakpointsEqual(checked.value, config)) {
      // The same boundary again is not an edit; the field only drops what was typed around it ("64 rem" back to "64rem").
      setDrafts(draftsOf(config));
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setSaveProblem(undefined);
      void startSync(id, config, checked.value);
    } else {
      setSaveProblem({ id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  // Desktop's number is only the width of its frame in the side-by-side view: no query holds it, so there is nothing to sync.
  const commitDesktop = async (setting: Breakpoint['setting'], draft: string): Promise<void> => {
    if (desktopProblem(config, draft, { translate, label }) !== undefined) {
      return;
    }
    const checked = checkedConfig(withDesktop(config, setting));
    if (!checked.ok) {
      return;
    }
    if (breakpointsEqual(checked.value, config)) {
      setDrafts(draftsOf(config));
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setSaveProblem(undefined);
      record(config, checked.value, translate('settings.breakpoints.desktop'));
    } else {
      setSaveProblem({ id: DESKTOP_ID, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  const commitName = async (id: string): Promise<void> => {
    const typed = (names[id] ?? '').trim();
    const current = list.find((breakpoint) => breakpoint.id === id);
    if (current === undefined || typed === label(current)) {
      setNames(namesOf(list, translate));
      return;
    }
    if (nameProblem(list, id, typed, { translate, label }) !== undefined) {
      return;
    }
    const next = withBreakpointName(config, id, typed);
    const saved = await indicator.track(save(next));
    if (!saved.ok) {
      setSaveProblem({ id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  const remove = async (breakpoint: Breakpoint): Promise<void> => {
    const name = label(breakpoint);
    const remembered = await rememberedCount(projectPath, breakpoint.id);
    if (remembered > 0) {
      const answer = await confirmDialog({
        title: translate('settings.breakpoints.removeTitle', { name }),
        body: translate('settings.breakpoints.removeBody', { count: remembered }),
        confirmLabel: translate('settings.breakpoints.removeConfirm'),
        danger: true,
      });
      if (answer === false) {
        return;
      }
    }
    const next = withBreakpointRemoved(config, breakpoint.id);
    const saved = await indicator.track(save(next));
    if (saved.ok) {
      setSyncMessage(undefined);
      record(config, next, name);
    } else {
      setSaveProblem({ id: breakpoint.id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  const startAdd = (): void => setAdding({ name: '', value: '' });
  const addView = adding === undefined ? undefined : previewForAdd(config, adding, translate, label);
  const addProblem = adding === undefined || addView === undefined ? undefined : problemForAdd(config, adding, addView.name, translate, label);
  const commitAdd = async (): Promise<void> => {
    if (adding === undefined || addView === undefined || addProblem !== undefined || adding.value.trim() === '') {
      return;
    }
    const entry = parseBreakpointEntry(adding.value);
    if (!entry.ok) {
      return;
    }
    const created = { id: nextBreakpointId(list), name: addView.name, setting: entry.value };
    const checked = checkedConfig(withBreakpointAdded(config, created));
    if (!checked.ok) {
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setAdding(undefined);
      record(config, checked.value, created.name);
    } else {
      setSaveProblem({ id: created.id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  // After a number is saved, the project's media queries that still hold its old value are looked for; a dialog opens only when
  // there are some (or when the search is slow, with skeleton rows). Nothing is written until the person confirms.
  const startSync = async (id: string, before: BreakpointConfig, after: BreakpointConfig): Promise<void> => {
    const old = before.list.find((breakpoint) => breakpoint.id === id);
    const next = after.list.find((breakpoint) => breakpoint.id === id);
    if (!breakpointSyncAvailable() || old === undefined || next === undefined) {
      return;
    }
    scanSerial.current += 1;
    const serial = scanSerial.current;
    setSyncMessage(undefined);
    const slow = window.setTimeout(() => {
      if (scanSerial.current === serial) {
        setRun({ id, before, after, scan: undefined });
      }
    }, SCAN_SLOW_MS);
    const answer = await scanBreakpointSyncRequest(projectPath, { key: id, old, next });
    window.clearTimeout(slow);
    if (scanSerial.current !== serial) {
      return;
    }
    if (answer.ok && answer.scan.files.length > 0) {
      setRun({ id, before, after, scan: answer.scan });
    } else {
      setRun(undefined);
    }
  };
  const apply = async (current: SyncRun, checkedPlaces: CheckedPlaces): Promise<void> => {
    if (current.scan === undefined) {
      return;
    }
    setSyncBusy(true);
    const result = await applyBreakpointSyncRequest(applyRequest(projectPath, current.id, current.scan, checkedPlaces));
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
    usage.refresh();
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
        {['desktop', ...list.map((breakpoint) => breakpoint.id)].map((id) => (
          <Skeleton key={id} height="72px" radius="12px" />
        ))}
      </section>
    );
  }
  const blocked = state.kind === 'blocked';
  const full = list.length >= BREAKPOINT_LIMITS.countMax;
  const ups = list.filter((breakpoint) => breakpoint.direction === 'up');
  const downs = list.filter((breakpoint) => breakpoint.direction === 'down');
  const renderCard = (breakpoint: Breakpoint) => {
    const Icon = deviceIconComponent(iconFor({ ...breakpoint, widthPx: canvasWidthPx(breakpoint) }, resolved));
    const draft = drafts[breakpoint.id] ?? formatBreakpoint(breakpoint.setting);
    const problem = valueProblem(config, breakpoint.id, draft, translate) ?? (saveProblem?.id === breakpoint.id ? saveProblem.message : undefined);
    const typed = parseBreakpointEntry(draft);
    const shown: Breakpoint = typed.ok
      ? { ...breakpoint, setting: typed.value, direction: directionOf(typed.value, config.desktop) ?? breakpoint.direction }
      : breakpoint;
    const name = label(breakpoint);
    const nameIssue = nameProblem(list, breakpoint.id, (names[breakpoint.id] ?? name).trim(), { translate, label });
    return (
      <div
        key={breakpoint.id}
        className="breakpoints-card"
        data-breakpoint={breakpoint.id}
        data-invalid={problem === undefined && nameIssue === undefined ? undefined : ''}
      >
        <span className="breakpoints-tile" aria-hidden="true">
          <Icon size={ICON_SIZE_PX} />
        </span>
        <div className="breakpoints-text">
          <input
            className="breakpoints-name-input"
            type="text"
            value={names[breakpoint.id] ?? name}
            disabled={!editable || blocked}
            maxLength={BREAKPOINT_LIMITS.nameCharsMax}
            spellCheck={false}
            aria-label={translate('settings.breakpoints.nameLabel', { device: name })}
            aria-invalid={nameIssue === undefined ? undefined : true}
            onChange={(event) => setNames({ ...names, [breakpoint.id]: event.currentTarget.value })}
            onBlur={() => void commitName(breakpoint.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setNames(namesOf(list, translate));
              }
            }}
          />
          <span className="breakpoints-query" id={`breakpoints-query-${breakpoint.id}`}>
            {`${translate('settings.breakpoints.query', { condition: breakpointCondition(shown) })} · ${translate(shown.direction === 'up' ? 'settings.breakpoints.side.up' : 'settings.breakpoints.side.down')}`}
          </span>
          <BreakpointUsageLine
            id={breakpoint.id}
            name={name}
            state={usage.state}
            pending={typed.ok && problem === undefined && (shown.setting.value !== breakpoint.setting.value || shown.setting.unit !== breakpoint.setting.unit)}
            expanded={usageOpen.has(breakpoint.id)}
            onExpand={() => setUsageOpen(toggledId(usageOpen, breakpoint.id))}
          />
        </div>
        <div className="breakpoints-field">
          <input
            className="breakpoints-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft}
            disabled={!editable || blocked}
            maxLength={BREAKPOINT_LIMITS.entryCharsMax}
            aria-label={translate('settings.breakpoints.widthLabel', { device: name })}
            aria-describedby={`breakpoints-query-${breakpoint.id}`}
            aria-invalid={problem === undefined ? undefined : true}
            onChange={(event) => setDrafts({ ...drafts, [breakpoint.id]: event.currentTarget.value })}
            onBlur={() => void commitValue(breakpoint.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                // Back to the saved value, without committing what was typed.
                event.preventDefault();
                event.stopPropagation();
                setSaveProblem(undefined);
                setDrafts({ ...drafts, [breakpoint.id]: formatBreakpoint(breakpoint.setting) });
              }
            }}
          />
          <span className="breakpoints-canvas">{translate('settings.breakpoints.canvas', { width: canvasWidthPx(shown) })}</span>
        </div>
        <button
          type="button"
          className="breakpoints-remove"
          disabled={!editable || blocked}
          data-tooltip={translate('settings.breakpoints.remove', { name })}
          aria-label={translate('settings.breakpoints.remove', { name })}
          onClick={() => void remove(breakpoint)}
        >
          <TrashIcon size={14} />
        </button>
        {usageOpen.has(breakpoint.id) && hasUsage(usage.state, breakpoint.id) && (
          <BreakpointUsageList id={breakpoint.id} state={usage.state} editable={editable && !blocked} onToggle={usage.toggle} onOpenFile={onOpenFile} />
        )}
        {(problem !== undefined || nameIssue !== undefined) && (
          <p className="breakpoints-problem" role="alert">
            {problem ?? nameIssue}
          </p>
        )}
      </div>
    );
  };
  const renderDesktop = () => {
    const draft = drafts[DESKTOP_ID] ?? formatBreakpoint(config.desktop);
    const problem = desktopProblem(config, draft, { translate, label }) ?? (saveProblem?.id === DESKTOP_ID ? saveProblem.message : undefined);
    const typed = parseBreakpointEntry(draft);
    const frame = desktopFramePx(typed.ok ? typed.value : config.desktop);
    return (
      <div className="breakpoints-card breakpoints-desktop-card" data-breakpoint={DESKTOP_ID} data-invalid={problem === undefined ? undefined : ''}>
        <span className="breakpoints-tile" aria-hidden="true">
          <DesktopIcon size={ICON_SIZE_PX} />
        </span>
        <div className="breakpoints-text">
          <span className="breakpoints-name">{translate('settings.breakpoints.desktop')}</span>
          <span className="breakpoints-query" id="breakpoints-query-desktop">
            {translate('settings.breakpoints.desktopNote')}
          </span>
        </div>
        <div className="breakpoints-field">
          <input
            className="breakpoints-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft}
            disabled={!editable || blocked}
            maxLength={BREAKPOINT_LIMITS.entryCharsMax}
            aria-label={translate('settings.breakpoints.widthLabel', { device: translate('settings.breakpoints.desktop') })}
            aria-describedby="breakpoints-query-desktop"
            aria-invalid={problem === undefined ? undefined : true}
            onChange={(event) => setDrafts({ ...drafts, [DESKTOP_ID]: event.currentTarget.value })}
            onBlur={() => void commitValue(DESKTOP_ID)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setSaveProblem(undefined);
                setDrafts({ ...drafts, [DESKTOP_ID]: formatBreakpoint(config.desktop) });
              }
            }}
          />
          <span className="breakpoints-canvas">{translate('settings.breakpoints.frame', { width: frame })}</span>
        </div>
        {problem !== undefined && (
          <p className="breakpoints-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
    );
  };
  return (
    <section className="breakpoints-settings" aria-label={translate('settings.tab.breakpoints')}>
      <SettingsSaveRow saving={indicator.state} />
      {syncMessage !== undefined && <SettingsNotice message={syncMessage} />}
      {blocked && <SettingsNotice message={translate('settings.breakpoints.error.file', { message: state.message })} />}
      <SettingsSection
        title={translate('settings.tab.breakpoints')}
        info={`${translate('settings.breakpoints.intro')} ${translate('settings.breakpoints.explain')}`}
      >
        <div className="breakpoints-cards">
          {ups.map(renderCard)}
          {renderDesktop()}
          {downs.map(renderCard)}
          {adding !== undefined && addView !== undefined && (
            <BreakpointAddCard
              projectPath={projectPath}
              draft={adding}
              onChange={setAdding}
              icon={addView.icon}
              condition={addView.condition}
              side={addView.direction}
              canvasPx={addView.canvasPx}
              placeholderValue={addView.placeholderValue}
              suggestedName={addView.suggestedName}
              candidate={addView.candidate}
              problem={addProblem}
              canAdd={addProblem === undefined && adding.value.trim() !== ''}
              onAdd={() => void commitAdd()}
              onCancel={() => setAdding(undefined)}
            />
          )}
        </div>
        <div className="breakpoints-actions">
          <button type="button" className="breakpoints-add" disabled={!editable || blocked || full || adding !== undefined} onClick={() => startAdd()}>
            <PlusIcon size={12} />
            {translate('settings.breakpoints.add')}
          </button>
          <span className="breakpoints-note">
            {full ? translate('settings.breakpoints.full', { count: BREAKPOINT_LIMITS.countMax }) : translate('settings.breakpoints.removeNote')}
          </span>
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

function toggledId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

function draftsOf(config: BreakpointConfig): Drafts {
  return {
    [DESKTOP_ID]: formatBreakpoint(config.desktop),
    ...Object.fromEntries(config.list.map((breakpoint) => [breakpoint.id, formatBreakpoint(breakpoint.setting)])),
  };
}

function namesOf(list: BreakpointList, translate: Translator): Drafts {
  return Object.fromEntries(list.map((breakpoint) => [breakpoint.id, breakpointLabel(breakpoint, translate)]));
}

// How many places of the project this breakpoint's sync remembers; the answer decides whether removing it asks first. A record that
// cannot be read asks nothing: it holds nothing anyone can rely on.
async function rememberedCount(projectPath: string, id: string): Promise<number> {
  try {
    const file = await readMetadata(projectPath, 'breakpointSync');
    const parsed = parseBreakpointSyncSource(file.source);
    if (!parsed.ok) {
      return 0;
    }
    const entry = entryOf(parsed.value, id);
    return entry.excluded.length + entry.linked.length;
  } catch {
    return 0;
  }
}

function suggestedName(list: BreakpointList, direction: BreakpointDirection, translate: Translator, label: (breakpoint: Breakpoint) => string): string {
  // Only the ones the person added count: the built-in Laptop, Tablet and Phone have names of their own.
  const count = list.filter((breakpoint) => breakpoint.direction === direction && !isBuiltinBreakpointId(breakpoint.id)).length;
  const keys = DEFAULT_NAMES[direction];
  const key = keys[Math.min(count, keys.length - 1)];
  const base = key === undefined ? direction : translate(key);
  return uniqueBreakpointName(list, base, label);
}

// Why this card's typed value cannot be saved, or undefined when it can (or is the saved value untouched).
function valueProblem(config: BreakpointConfig, id: string, draft: string, translate: Translator): string | undefined {
  const current = config.list.find((breakpoint) => breakpoint.id === id);
  if (current === undefined || draft === formatBreakpoint(current.setting)) {
    return undefined;
  }
  const entry = parseBreakpointEntry(draft);
  if (!entry.ok) {
    return entryProblem(entry.error.code, translate);
  }
  return orderProblem(withSettingInPlace(config, id, entry.value), id, translate);
}

// Why Desktop's typed frame width cannot be saved: not a width, or it would put a breakpoint on the other side of Desktop (or on it).
function desktopProblem(
  config: BreakpointConfig,
  draft: string,
  naming: { readonly translate: Translator; readonly label: (breakpoint: Breakpoint) => string },
): string | undefined {
  const { translate, label } = naming;
  if (draft === formatBreakpoint(config.desktop)) {
    return undefined;
  }
  const entry = parseBreakpointEntry(draft);
  if (!entry.ok) {
    return entryProblem(entry.error.code, translate);
  }
  const blocker = desktopBlocker(config, entry.value);
  return blocker === undefined
    ? undefined
    : translate('settings.breakpoints.error.desktopFlips', { name: label(blocker), limit: formatBreakpoint(blocker.setting) });
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

// The breakpoint that does not fit between its neighbours (Desktop among them), named, with the limit it has to stay within.
function orderProblem(config: BreakpointConfig, id: string, translate: Translator): string | undefined {
  const conflict = conflictAt(config, id);
  const row = config.list.find((breakpoint) => breakpoint.id === id);
  if (conflict === undefined || row === undefined) {
    return undefined;
  }
  const against =
    conflict.against.breakpoint === undefined ? translate('settings.breakpoints.desktop') : breakpointLabel(conflict.against.breakpoint, translate);
  const limit = formatBreakpoint(conflict.against.setting);
  const name = breakpointLabel(row, translate);
  return conflict.relation === 'smaller'
    ? translate('settings.breakpoints.error.order', { row: name, above: against, limit })
    : translate('settings.breakpoints.error.orderBelow', { row: name, below: against, limit });
}

function nameProblem(
  list: BreakpointList,
  id: string,
  name: string,
  naming: { readonly translate: Translator; readonly label: (breakpoint: Breakpoint) => string },
): string | undefined {
  const { translate, label } = naming;
  const taken = list.some((breakpoint) => breakpoint.id !== id && label(breakpoint).trim().toLowerCase() === name.trim().toLowerCase());
  return isBreakpointName(name) && !taken ? undefined : translate('settings.breakpoints.error.name', { maximum: BREAKPOINT_LIMITS.nameCharsMax });
}

// What the card being filled in will be, as far as it is typed: its name (the default while the field is empty), the icon, the query and the
// canvas it would have (a placeholder value stands in until the value parses), and the breakpoint itself once the value does.
function previewForAdd(
  config: BreakpointConfig,
  adding: AddDraft,
  translate: Translator,
  label: (breakpoint: Breakpoint) => string,
): {
  readonly name: string;
  readonly suggestedName: string;
  readonly icon: DeviceIconKind;
  readonly condition: string;
  readonly canvasPx: number;
  readonly placeholderValue: string;
  readonly candidate: Breakpoint | undefined;
  readonly direction: BreakpointDirection;
} {
  const placeholderValue = '100rem';
  const entry = parseBreakpointEntry(adding.value);
  const fallback = parseBreakpointEntry(placeholderValue);
  const setting = entry.ok ? entry.value : fallback.ok ? fallback.value : { value: 100, unit: 'rem' as const };
  // The side is the number's, against Desktop's: wider is `width >= X`, narrower is `width < X`. Empty, it is the wider one the placeholder is.
  const direction = directionOf(setting, config.desktop) ?? 'up';
  const suggested = suggestedName(config.list, direction, translate, label);
  const name = adding.name.trim() === '' ? suggested : adding.name.trim();
  const full = config.list.length >= BREAKPOINT_LIMITS.countMax;
  const created: Breakpoint = { id: full ? 'bp-new' : nextBreakpointId(config.list), name, direction, setting };
  const resolved = resolveBreakpoints(withBreakpointAdded(config, created).list);
  const item = resolved.find((breakpoint) => breakpoint.id === created.id);
  return {
    name,
    suggestedName: suggested,
    icon: item === undefined ? 'tablet' : iconFor(item, resolved),
    condition: breakpointCondition(created),
    canvasPx: canvasWidthPx(created),
    placeholderValue,
    candidate: entry.ok && directionOf(entry.value, config.desktop) !== undefined ? created : undefined,
    direction,
  };
}

function problemForAdd(
  config: BreakpointConfig,
  adding: AddDraft,
  name: string,
  translate: Translator,
  label: (breakpoint: Breakpoint) => string,
): string | undefined {
  const nameIssue = nameProblem(config.list, '', name, { translate, label });
  if (nameIssue !== undefined) {
    return nameIssue;
  }
  if (adding.value.trim() === '') {
    return undefined;
  }
  const entry = parseBreakpointEntry(adding.value);
  if (!entry.ok) {
    return entryProblem(entry.error.code, translate);
  }
  if (config.list.length >= BREAKPOINT_LIMITS.countMax) {
    return translate('settings.breakpoints.full', { count: BREAKPOINT_LIMITS.countMax });
  }
  if (directionOf(entry.value, config.desktop) === undefined) {
    return translate('settings.breakpoints.error.sameAsDesktop', { value: formatBreakpoint(config.desktop) });
  }
  const twin = config.list.find((breakpoint) => boundaryPx(breakpoint.setting) === boundaryPx(entry.value));
  if (twin !== undefined) {
    return translate('settings.breakpoints.error.same', { other: label(twin), value: formatBreakpoint(twin.setting) });
  }
  return undefined;
}
