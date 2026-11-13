// The Settings panel's Secrets tab: the names in the project's `.env`, their values hidden until a
// person reveals one, with edit, delete and add. The list holds names only. A value is fetched when
// a person reveals it or begins editing it (`readSecret`) and lives in this component's state until the
// tab closes, the project changes or the file does, so a hidden value is in neither the DOM nor the
// React tree. Every change names the revision it was authored against; if the file changed on disk the
// save is refused and the person reloads (nothing is overwritten). The list reloads when the window
// regains focus, which is how an outside edit shows up. The last listing per project is kept in memory
// (secretsCache.ts), so a reopened tab paints its names at once and refreshes behind them; with nothing
// cached it paints placeholder rows, never a word.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ENV_LIMITS } from '../../../shared/properties/envFile';
import type { SecretsChange, SecretsErrorCode, SecretsListing, SecretsResult, SecretSummary } from '../../../shared/properties/secrets';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { HideIcon, LockIcon, PencilIcon, PlusIcon, PreviewIcon, TrashIcon } from '../../ui/Icons';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import InfoHint from '../../ui/InfoHint';
import { cachedSecretsListing, secretsListingCache } from './secretsCache';
import { SecretsUnavailableError, applySecretsChange, ignoreSecretsFile, listSecrets, readSecret } from './secretsBridge';
import { SECRET_MASK, SECRET_NAME_EXAMPLE, VALUE_KIB_MAX, nameProblem, problemKey, valueProblem, type DraftProblem } from './secretsModel';
import './projectSettings.css';

type ListingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly code: SecretsErrorCode }
  | { readonly kind: 'unavailable' }
  // `refreshFailure` is set when a background refresh failed over a listing that is still shown: the names stay, the notice says why.
  | { readonly kind: 'ready'; readonly listing: SecretsListing; readonly refreshFailure: SecretsErrorCode | undefined };

/** A draft being typed: a new secret, or one being edited. `loaded` is false while its value is fetched. */
type Draft =
  | { readonly kind: 'none' }
  | { readonly kind: 'add'; readonly name: string; readonly value: string; readonly problem: string | undefined }
  | {
      readonly kind: 'edit';
      readonly index: number;
      readonly name: string;
      readonly value: string;
      readonly original: string | undefined;
      readonly problem: string | undefined;
    };

type Revealed = ReadonlyMap<number, string>;

const NO_REVEALED: Revealed = new Map();

/** Placeholder rows drawn on a first load: about what a small `.env` fills. */
const SECRETS_SKELETON_ROWS = 4;

export default function SecretsTab({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const { state, replace, reload } = useListing(projectPath);
  const [revealed, setRevealed] = useState<Revealed>(NO_REVEALED);
  const [draft, setDraft] = useState<Draft>({ kind: 'none' });
  const [failure, setFailure] = useState<SecretsErrorCode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const revision = state.kind === 'ready' ? state.listing.revision : undefined;

  // A new file revision (a save here, an outside edit) hides everything again: the indexes may have moved.
  useEffect(() => setRevealed(NO_REVEALED), [revision, projectPath]);
  useEffect(() => {
    setDraft({ kind: 'none' });
    setFailure(undefined);
  }, [projectPath]);

  if (state.kind === 'loading') {
    // Nothing cached yet: the real chrome and rows in placeholder form, so the tab does not move when the names arrive.
    return (
      <div className="secrets">
        <div className="secrets-head">
          <SecretsHeading />
          <div className="secrets-actions">
            <button type="button" className="primary" disabled>
              <PlusIcon size={12} />
              {translate('settings.secrets.add')}
            </button>
          </div>
        </div>
        <SkeletonRows count={SECRETS_SKELETON_ROWS} row={(widthPercent) => <SecretSkeletonRow widthPercent={widthPercent} />} />
      </div>
    );
  }
  if (state.kind === 'unavailable') {
    // The running app predates the channels: only a restart helps, so no reload is offered.
    return (
      <p className="secrets-note" role="alert">
        {translate('settings.secrets.unavailable')}
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div className="secrets-note" role="alert">
        <p>{translate(problemKey(state.code))}</p>
        <button type="button" className="ghost" onClick={reload}>
          {translate('settings.secrets.reload')}
        </button>
      </div>
    );
  }
  const { listing } = state;
  // A failed action wins over a failed background refresh; a refresh failure offers Reload for any code.
  const notice = failure ?? state.refreshFailure;

  const show = async (index: number): Promise<void> => {
    const read = await readSecret(projectPath, listing.revision, index);
    if (read.ok) {
      setRevealed((current) => new Map(current).set(index, read.value.value));
    } else {
      setFailure(read.error.code);
    }
  };
  const hide = (index: number): void => {
    setRevealed((current) => {
      const next = new Map(current);
      next.delete(index);
      return next;
    });
  };
  const everyShown = listing.entries.length > 0 && listing.entries.every((entry) => revealed.has(entry.index));
  const toggleAll = async (): Promise<void> => {
    if (everyShown) {
      setRevealed(NO_REVEALED);
      return;
    }
    const reads = await Promise.all(
      listing.entries.map(async (entry) => ({ index: entry.index, read: await readSecret(projectPath, listing.revision, entry.index) })),
    );
    const next = new Map<number, string>();
    for (const { index, read } of reads) {
      if (read.ok) {
        next.set(index, read.value.value);
      } else {
        setFailure(read.error.code);
      }
    }
    setRevealed(next);
  };

  const commit = async (change: SecretsChange): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const applied = await applySecretsChange(projectPath, listing.revision, change);
    setBusy(false);
    if (applied.ok) {
      replace(applied.value);
      return true;
    }
    setFailure(applied.error.code);
    return false;
  };

  const beginEdit = async (entry: SecretSummary): Promise<void> => {
    setFailure(undefined);
    setDraft({ kind: 'edit', index: entry.index, name: entry.name, value: '', original: undefined, problem: undefined });
    if (entry.multiline) {
      return;
    }
    const read = await readSecret(projectPath, listing.revision, entry.index);
    if (!read.ok) {
      setDraft({ kind: 'none' });
      setFailure(read.error.code);
      return;
    }
    setDraft((current) =>
      current.kind === 'edit' && current.index === entry.index ? { ...current, value: read.value.value, original: read.value.value } : current,
    );
  };

  const submit = async (): Promise<void> => {
    if (draft.kind === 'none' || busy) {
      return;
    }
    const own = draft.kind === 'edit' ? draft.index : undefined;
    const problem =
      nameProblem(draft.name, listing.entries, own) ?? (draft.kind === 'edit' && draft.original === undefined ? undefined : valueProblem(draft.value));
    if (problem !== undefined) {
      setDraft({ ...draft, problem: describe(translate, problem) });
      return;
    }
    if (draft.kind === 'add') {
      if (await commit({ kind: 'add', name: draft.name, value: draft.value })) {
        setDraft({ kind: 'none' });
      }
      return;
    }
    const entry = listing.entries.find((candidate) => candidate.index === draft.index);
    const valueChanged = draft.original !== undefined && draft.value !== draft.original;
    if (entry?.name === draft.name && !valueChanged) {
      setDraft({ kind: 'none' });
      return;
    }
    if (await commit({ kind: 'update', index: draft.index, name: draft.name, value: valueChanged ? draft.value : undefined })) {
      setDraft({ kind: 'none' });
    }
  };

  const remove = async (entry: SecretSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: translate('settings.secrets.delete.title', { name: entry.name }),
      body: translate('settings.secrets.delete.body'),
      confirmLabel: translate('settings.secrets.delete.confirm'),
      cancelLabel: translate('settings.secrets.cancel'),
      danger: true,
    });
    if (confirmed === true) {
      await commit({ kind: 'remove', index: entry.index });
    }
  };

  const ignore = async (): Promise<void> => {
    const confirmed = await confirmDialog({
      title: translate('settings.secrets.ignore.title'),
      body: translate('settings.secrets.ignore.body'),
      confirmLabel: translate('settings.secrets.ignore.confirm'),
      cancelLabel: translate('settings.secrets.cancel'),
    });
    if (confirmed !== true) {
      return;
    }
    const result = await ignoreSecretsFile(projectPath);
    if (result.ok) {
      replace(result.value);
    } else {
      setFailure(result.error.code);
    }
  };

  const empty = listing.entries.length === 0 && draft.kind !== 'add';
  return (
    <div className="secrets">
      <div className="secrets-head">
        <SecretsHeading />
        <div className="secrets-actions">
          {listing.entries.length > 0 && (
            <button type="button" className="ghost" onClick={() => void toggleAll()}>
              {translate(everyShown ? 'settings.secrets.hideAll' : 'settings.secrets.revealAll')}
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={draft.kind === 'add' || busy}
            onClick={() => setDraft({ kind: 'add', name: '', value: '', problem: undefined })}
          >
            <PlusIcon size={12} />
            {translate('settings.secrets.add')}
          </button>
        </div>
      </div>
      {listing.ignore === 'not-ignored' && (
        <div className="secrets-warning" role="status">
          <span>{translate('settings.secrets.ignore.warning')}</span>
          <button type="button" className="ghost" onClick={() => void ignore()}>
            {translate('settings.secrets.ignore.action')}
          </button>
        </div>
      )}
      {listing.ignore === 'tracked' && (
        <div className="secrets-warning" role="status">
          <span>{translate('settings.secrets.tracked.warning')}</span>
        </div>
      )}
      {notice !== undefined && (
        <div className="secrets-warning secrets-failure" role="alert">
          <span>{translate(problemKey(notice))}</span>
          {(failure === undefined || failure === 'changed' || failure === 'not-found') && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setFailure(undefined);
                setDraft({ kind: 'none' });
                reload();
              }}
            >
              {translate('settings.secrets.reload')}
            </button>
          )}
        </div>
      )}
      {empty && (
        <div className="secrets-empty">
          <LockIcon size={20} />
          <strong>{translate('settings.secrets.empty.title')}</strong>
          <span>{translate(listing.exists ? 'settings.secrets.empty.body' : 'settings.secrets.empty.noFileBody')}</span>
          {!listing.exists && (
            <button type="button" className="primary" disabled={busy} onClick={() => void commit({ kind: 'create' })}>
              {translate('settings.secrets.create')}
            </button>
          )}
        </div>
      )}
      <div className="secrets-list" role="list">
        {draft.kind === 'add' && (
          <DraftRow draft={draft} busy={busy} onChange={setDraft} onSubmit={() => void submit()} onCancel={() => setDraft({ kind: 'none' })} />
        )}
        {listing.entries.map((entry) =>
          draft.kind === 'edit' && draft.index === entry.index ? (
            <DraftRow
              key={entry.index}
              draft={draft}
              busy={busy}
              valueLocked={entry.multiline}
              onChange={setDraft}
              onSubmit={() => void submit()}
              onCancel={() => setDraft({ kind: 'none' })}
            />
          ) : (
            <SecretRow
              key={entry.index}
              entry={entry}
              shown={revealed.get(entry.index)}
              onToggle={() => (revealed.has(entry.index) ? hide(entry.index) : void show(entry.index))}
              onEdit={() => void beginEdit(entry)}
              onDelete={() => void remove(entry)}
            />
          ),
        )}
      </div>
      {listing.invalidLines > 0 && <p className="secrets-note">{translate('settings.secrets.invalidLines', { count: listing.invalidLines })}</p>}
    </div>
  );
}

function SecretsHeading() {
  const translate = useTranslate();
  return (
    <div className="secrets-heading">
      <h3>
        {translate('settings.secrets.title')}
        <InfoHint text={translate('settings.secrets.info')} />
      </h3>
      <p>{translate('settings.secrets.intro')}</p>
    </div>
  );
}

// A row's shape with nothing in it: the name, the mask and the three icon buttons, in the slots a real row uses so the heights match.
function SecretSkeletonRow({ widthPercent }: { readonly widthPercent: number }) {
  return (
    <div className="secrets-row secrets-row-skeleton">
      <Skeleton width={`${widthPercent}%`} />
      <span className="secrets-skeleton-value">
        <Skeleton width="60%" />
      </span>
      <span className="secrets-row-actions">
        {[0, 1, 2].map((slot) => (
          <span key={slot} className="secrets-skeleton-slot">
            <Skeleton width="14px" height="14px" radius="4px" />
          </span>
        ))}
      </span>
    </div>
  );
}

function SecretRow({
  entry,
  shown,
  onToggle,
  onEdit,
  onDelete,
}: {
  readonly entry: SecretSummary;
  readonly shown: string | undefined;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const translate = useTranslate();
  const visible = shown !== undefined;
  return (
    <div className="secrets-row" role="listitem">
      <span className="secrets-name" title={entry.duplicate ? translate('settings.secrets.duplicate') : undefined}>
        {entry.name}
      </span>
      {entry.multiline ? (
        <span className="secrets-value secrets-value-static" title={translate('settings.secrets.multiline')}>
          {visible ? shown : SECRET_MASK}
        </span>
      ) : (
        <button type="button" className="secrets-value" aria-label={translate('settings.secrets.edit.action', { name: entry.name })} onClick={onEdit}>
          {visible ? shown : SECRET_MASK}
        </button>
      )}
      <span className="secrets-row-actions">
        <button
          type="button"
          className="ghost"
          aria-pressed={visible}
          aria-label={translate(visible ? 'settings.secrets.hide.action' : 'settings.secrets.reveal.action', { name: entry.name })}
          title={translate(visible ? 'settings.secrets.hide.action' : 'settings.secrets.reveal.action', { name: entry.name })}
          onClick={onToggle}
        >
          {visible ? <HideIcon size={14} /> : <PreviewIcon size={14} />}
        </button>
        <button
          type="button"
          className="ghost"
          aria-label={translate('settings.secrets.edit.action', { name: entry.name })}
          title={translate('settings.secrets.edit.action', { name: entry.name })}
          onClick={onEdit}
        >
          <PencilIcon size={14} />
        </button>
        <button
          type="button"
          className="ghost danger"
          aria-label={translate('settings.secrets.delete.action', { name: entry.name })}
          title={translate('settings.secrets.delete.action', { name: entry.name })}
          onClick={onDelete}
        >
          <TrashIcon size={14} />
        </button>
      </span>
      {entry.duplicate && <span className="secrets-hint">{translate('settings.secrets.duplicate')}</span>}
      {entry.multiline && <span className="secrets-hint">{translate('settings.secrets.multiline')}</span>}
    </div>
  );
}

function DraftRow({
  draft,
  busy,
  valueLocked = false,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly draft: Exclude<Draft, { readonly kind: 'none' }>;
  readonly busy: boolean;
  readonly valueLocked?: boolean;
  readonly onChange: (next: Draft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const translate = useTranslate();
  const loading = draft.kind === 'edit' && draft.original === undefined && !valueLocked;
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="secrets-row secrets-draft" role="listitem">
      <input
        className="secrets-input secrets-name-input"
        aria-label={translate('settings.secrets.name')}
        placeholder={SECRET_NAME_EXAMPLE}
        value={draft.name}
        maxLength={ENV_LIMITS.nameCharsMax + 1}
        spellCheck={false}
        autoComplete="off"
        autoFocus={draft.kind === 'add'}
        onChange={(event) => onChange({ ...draft, name: event.target.value, problem: undefined })}
        onKeyDown={keys}
      />
      {valueLocked ? (
        <span className="secrets-value secrets-value-static">{SECRET_MASK}</span>
      ) : (
        <input
          className="secrets-input"
          aria-label={translate('settings.secrets.value')}
          placeholder={translate('settings.secrets.value')}
          value={draft.value}
          disabled={loading}
          spellCheck={false}
          autoComplete="off"
          autoFocus={draft.kind === 'edit'}
          onChange={(event) => onChange({ ...draft, value: event.target.value, problem: undefined })}
          onKeyDown={keys}
        />
      )}
      <span className="secrets-row-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {translate('settings.secrets.cancel')}
        </button>
        <button type="button" className="primary" disabled={busy || loading} onClick={onSubmit}>
          {translate('settings.secrets.save')}
        </button>
      </span>
      {draft.problem !== undefined && (
        <span className="secrets-hint secrets-problem" role="alert">
          {draft.problem}
        </span>
      )}
      {valueLocked && <span className="secrets-hint">{translate('settings.secrets.multiline')}</span>}
    </div>
  );
}

function describe(translate: Translator, problem: DraftProblem): string {
  if (problem === 'nameTooLong') {
    return translate(problemKey(problem), { max: ENV_LIMITS.nameCharsMax });
  }
  if (problem === 'valueTooLong') {
    return translate(problemKey(problem), { max: VALUE_KIB_MAX });
  }
  return translate(problemKey(problem));
}

// The listing: the cached one at once when this project has been read before, otherwise loading; then a
// read on mount and whenever the window regains focus (an edit outside Stacki shows then). A reply for a
// project the panel has since left is dropped. A failed read keeps a listing already shown.
function useListing(projectPath: string): { readonly state: ListingState; readonly replace: (listing: SecretsListing) => void; readonly reload: () => void } {
  const [state, setState] = useState<ListingState>(() => initialState(projectPath));
  const latest = useRef(0);
  const seeded = useRef(projectPath);
  const load = useCallback(() => {
    latest.current += 1;
    const ticket = latest.current;
    const settle = (result: SecretsResult<SecretsListing> | 'unavailable' | undefined): void => {
      if (ticket !== latest.current) {
        return;
      }
      if (result === 'unavailable') {
        setState({ kind: 'unavailable' });
      } else if (result === undefined) {
        setState((current) => failedState(current, 'unreadable'));
      } else if (result.ok) {
        secretsListingCache.set(projectPath, result.value);
        // An unchanged revision keeps the state object, so a refocus does not redraw or hide anything.
        setState((current) =>
          current.kind === 'ready' &&
          current.refreshFailure === undefined &&
          current.listing.revision === result.value.revision &&
          current.listing.ignore === result.value.ignore
            ? current
            : { kind: 'ready', listing: result.value, refreshFailure: undefined },
        );
      } else {
        setState((current) => failedState(current, result.error.code));
      }
    };
    // A rejected call is a broken boundary, not an operating failure; the panel says it could not read the file and shows no detail.
    void listSecrets(projectPath).then(settle, (error: unknown) => settle(error instanceof SecretsUnavailableError ? 'unavailable' : undefined));
  }, [projectPath]);
  useEffect(() => {
    if (seeded.current !== projectPath) {
      seeded.current = projectPath;
      setState(initialState(projectPath));
    }
    load();
    window.addEventListener('focus', load);
    return () => {
      latest.current += 1;
      window.removeEventListener('focus', load);
    };
  }, [load, projectPath]);
  const replace = useCallback(
    (listing: SecretsListing) => {
      latest.current += 1;
      secretsListingCache.set(projectPath, listing);
      setState({ kind: 'ready', listing, refreshFailure: undefined });
    },
    [projectPath],
  );
  return { state, replace, reload: load };
}

// What the tab paints in its first frame: the names it showed last time, or the placeholder when it has none.
function initialState(projectPath: string): ListingState {
  const listing = cachedSecretsListing(projectPath);
  return listing === undefined ? { kind: 'loading' } : { kind: 'ready', listing, refreshFailure: undefined };
}

// A failed read keeps the names on screen and names the failure beside them; with nothing to keep it is the full failure.
function failedState(current: ListingState, code: SecretsErrorCode): ListingState {
  if (current.kind === 'ready') {
    return current.refreshFailure === code ? current : { ...current, refreshFailure: code };
  }
  return { kind: 'failed', code };
}
