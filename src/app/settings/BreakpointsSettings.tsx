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
  BREAKPOINT_DEFAULT_LIST,
  BREAKPOINT_LIMITS,
  boundaryPx,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  checkedList,
  conflictAt,
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
  type Breakpoint,
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
import { CloseIcon, DesktopIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import type { BreakpointSyncScan } from '../../../shared/properties/breakpointSyncPlan';
import { applyBreakpointSyncRequest, breakpointSyncAvailable, restoreBreakpointSyncRequest, scanBreakpointSyncRequest } from '../../ipc/breakpointSyncBridge';
import { deviceIconComponent } from '../../features/preview/deviceIcons';
import { iconFor } from '../../features/preview/breakpointDevices';
import { breakpointLabel } from '../../features/preview/breakpointLabel';
import { BreakpointSyncDialog } from './BreakpointSyncDialog';
import { BreakpointUsageLine, BreakpointUsageList, hasUsage } from './BreakpointUsage';
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
  readonly before: BreakpointList;
  readonly after: BreakpointList;
  readonly scan: BreakpointSyncScan | undefined;
}

type Drafts = Readonly<Record<string, string>>;

interface AddDraft {
  readonly direction: BreakpointDirection;
  readonly name: string;
  readonly value: string;
}

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
  const { list, resolved, state, save } = useProjectBreakpoints(projectPath);
  const indicator = useSaveIndicator();
  const usage = useBreakpointUsage(projectPath, list);
  const [usageOpen, setUsageOpen] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(list));
  const [names, setNames] = useState<Drafts>(() => namesOf(list, translate));
  const [adding, setAdding] = useState<AddDraft>();
  const [run, setRun] = useState<SyncRun>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>();
  const scanSerial = useRef(0);
  const [saveProblem, setSaveProblem] = useState<{ readonly id: string; readonly message: string }>();
  // The saved list is the truth: an edit in another window or a pull puts it back in the fields.
  useEffect(() => {
    setDrafts(draftsOf(list));
    setNames(namesOf(list, translate));
    setSaveProblem(undefined);
  }, [list, translate]);

  const label = (breakpoint: Breakpoint): string => breakpointLabel(breakpoint, translate);
  const record = (before: BreakpointList, after: BreakpointList, name: string): void => {
    onRecordUndo?.({
      label: name,
      labelRef: messageRef('settings.breakpoints.undoLabel'),
      undo: async () => void (await save(before)),
      redo: async () => void (await save(after)),
    });
  };

  const commitValue = async (id: string): Promise<void> => {
    const entry = parseBreakpointEntry(drafts[id] ?? '');
    const current = list.find((breakpoint) => breakpoint.id === id);
    if (!entry.ok || current === undefined || valueProblem(list, id, drafts[id] ?? '', translate) !== undefined) {
      // The card already says why; nothing is written and what was typed stays to be fixed.
      return;
    }
    const next = withBreakpointSetting(list, id, entry.value);
    const checked = checkedList(next);
    if (!checked.ok) {
      return;
    }
    if (breakpointsEqual(checked.value, list)) {
      // The same boundary again is not an edit; the field only drops what was typed around it ("64 rem" back to "64rem").
      setDrafts(draftsOf(list));
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setSaveProblem(undefined);
      void startSync(id, list, checked.value);
    } else {
      setSaveProblem({ id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
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
    const next = withBreakpointName(list, id, typed);
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
    const next = withBreakpointRemoved(list, breakpoint.id);
    const saved = await indicator.track(save(next));
    if (saved.ok) {
      setSyncMessage(undefined);
      record(list, next, name);
    } else {
      setSaveProblem({ id: breakpoint.id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  const startAdd = (direction: BreakpointDirection): void => setAdding({ direction, name: suggestedName(list, direction, translate, label), value: '' });
  const addProblem = adding === undefined ? undefined : problemForAdd(list, adding, translate, label);
  const commitAdd = async (): Promise<void> => {
    if (adding === undefined || addProblem !== undefined || adding.value.trim() === '') {
      return;
    }
    const entry = parseBreakpointEntry(adding.value);
    if (!entry.ok) {
      return;
    }
    const created: Breakpoint = { id: nextBreakpointId(list), name: adding.name.trim(), direction: adding.direction, setting: entry.value };
    const next = withBreakpointAdded(list, created);
    const checked = checkedList(next);
    if (!checked.ok) {
      return;
    }
    const saved = await indicator.track(save(checked.value));
    if (saved.ok) {
      setAdding(undefined);
      record(list, checked.value, created.name ?? '');
    } else {
      setSaveProblem({ id: created.id, message: translate('settings.breakpoints.error.save', { message: saved.error.message }) });
    }
  };

  // After a number is saved, the project's media queries that still hold its old value are looked for; a dialog opens only when
  // there are some (or when the search is slow, with skeleton rows). Nothing is written until the person confirms.
  const startSync = async (id: string, before: BreakpointList, after: BreakpointList): Promise<void> => {
    const old = before.find((breakpoint) => breakpoint.id === id);
    const next = after.find((breakpoint) => breakpoint.id === id);
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
    const problem = valueProblem(list, breakpoint.id, draft, translate) ?? (saveProblem?.id === breakpoint.id ? saveProblem.message : undefined);
    const typed = parseBreakpointEntry(draft);
    const shown: Breakpoint = typed.ok ? { ...breakpoint, setting: typed.value } : breakpoint;
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
            {translate('settings.breakpoints.query', { condition: breakpointCondition(shown) })}
          </span>
          <BreakpointUsageLine
            id={breakpoint.id}
            name={name}
            state={usage.state}
            pending={typed.ok && problem === undefined && !breakpointsEqual([shown], [breakpoint])}
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
          <div className="breakpoints-card" data-breakpoint="desktop">
            <span className="breakpoints-tile" aria-hidden="true">
              <DesktopIcon size={ICON_SIZE_PX} />
            </span>
            <div className="breakpoints-text">
              <span className="breakpoints-name">{translate('settings.breakpoints.desktop')}</span>
            </div>
            <span className="breakpoints-pill">{translate('settings.breakpoints.desktopWidth')}</span>
          </div>
          {downs.map(renderCard)}
          {adding !== undefined && (
            <div className="breakpoints-card breakpoints-add-card" data-breakpoint="new" data-invalid={addProblem === undefined ? undefined : ''}>
              <span className="breakpoints-tile" aria-hidden="true">
                <PlusIcon size={ICON_SIZE_PX} />
              </span>
              <div className="breakpoints-text">
                <input
                  className="breakpoints-name-input"
                  type="text"
                  value={adding.name}
                  maxLength={BREAKPOINT_LIMITS.nameCharsMax}
                  spellCheck={false}
                  aria-label={translate('settings.breakpoints.nameLabel', { device: adding.name })}
                  onChange={(event) => setAdding({ ...adding, name: event.currentTarget.value })}
                />
                <div className="breakpoints-direction" role="radiogroup" aria-label={translate('settings.breakpoints.direction.group')}>
                  {(['up', 'down'] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      role="radio"
                      aria-checked={adding.direction === direction}
                      className={adding.direction === direction ? 'on' : ''}
                      onClick={() => setAdding({ ...adding, direction, name: suggestedName(list, direction, translate, label) })}
                    >
                      {translate(direction === 'up' ? 'settings.breakpoints.direction.up' : 'settings.breakpoints.direction.down')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="breakpoints-field">
                <input
                  className="breakpoints-input"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoFocus
                  value={adding.value}
                  placeholder={adding.direction === 'up' ? '100rem' : '20rem'}
                  maxLength={BREAKPOINT_LIMITS.entryCharsMax}
                  aria-label={translate('settings.breakpoints.widthLabel', { device: adding.name })}
                  aria-invalid={addProblem === undefined ? undefined : true}
                  onChange={(event) => setAdding({ ...adding, value: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitAdd();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      setAdding(undefined);
                    }
                  }}
                />
                <span className="breakpoints-add-actions">
                  <button
                    type="button"
                    className="breakpoints-add-confirm"
                    disabled={addProblem !== undefined || adding.value.trim() === ''}
                    onClick={() => void commitAdd()}
                  >
                    {translate('settings.breakpoints.addConfirm')}
                  </button>
                  <button type="button" className="breakpoints-add-cancel" aria-label={translate('ui.cancel')} onClick={() => setAdding(undefined)}>
                    <CloseIcon size={12} />
                  </button>
                </span>
              </div>
              {addProblem !== undefined && adding.value.trim() !== '' && (
                <p className="breakpoints-problem" role="alert">
                  {addProblem}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="breakpoints-actions">
          <button type="button" className="breakpoints-add" disabled={!editable || blocked || full || adding !== undefined} onClick={() => startAdd('up')}>
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

function draftsOf(list: BreakpointList): Drafts {
  return Object.fromEntries(list.map((breakpoint) => [breakpoint.id, formatBreakpoint(breakpoint.setting)]));
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
function valueProblem(list: BreakpointList, id: string, draft: string, translate: Translator): string | undefined {
  const index = list.findIndex((breakpoint) => breakpoint.id === id);
  const current = list[index];
  if (current === undefined || draft === formatBreakpoint(current.setting)) {
    return undefined;
  }
  const entry = parseBreakpointEntry(draft);
  if (!entry.ok) {
    return entryProblem(entry.error.code, translate);
  }
  return orderProblem(withBreakpointSetting(list, id, entry.value), index, translate);
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

// The breakpoint that does not fit between its neighbours, named, with the limit it has to stay within.
function orderProblem(list: BreakpointList, index: number, translate: Translator): string | undefined {
  const conflict = conflictAt(list, index);
  const row = list[index];
  if (conflict === undefined || row === undefined) {
    return undefined;
  }
  const params = {
    row: breakpointLabel(row, translate),
    above: breakpointLabel(conflict.against, translate),
    limit: formatBreakpoint(conflict.against.setting),
  };
  return conflict.relation === 'smaller'
    ? translate('settings.breakpoints.error.order', params)
    : translate('settings.breakpoints.error.orderBelow', { row: params.row, below: params.above, limit: params.limit });
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

function problemForAdd(list: BreakpointList, adding: AddDraft, translate: Translator, label: (breakpoint: Breakpoint) => string): string | undefined {
  const nameIssue = nameProblem(list, '', adding.name.trim(), { translate, label });
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
  if (list.length >= BREAKPOINT_LIMITS.countMax) {
    return translate('settings.breakpoints.full', { count: BREAKPOINT_LIMITS.countMax });
  }
  const created: Breakpoint = { id: nextBreakpointId(list), name: adding.name.trim(), direction: adding.direction, setting: entry.value };
  const twin = list.find((breakpoint) => boundaryPx(breakpoint.setting) === boundaryPx(created.setting));
  if (twin !== undefined) {
    return translate('settings.breakpoints.error.same', { other: label(twin), value: formatBreakpoint(twin.setting) });
  }
  return checkedList(withBreakpointAdded(list, created)).ok ? undefined : translate('settings.breakpoints.error.direction');
}

export { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints };
