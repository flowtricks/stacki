import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import RepositoryPicker from '../../ui/RepositoryPicker';
import { parseGitHubRepository } from '../../../shared/ipc/githubRepository';
import { useEffect, useRef, useState } from 'react';
import type { Result } from '../../../shared/core/result';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { CheckIcon, ExternalIcon } from '../../ui/Icons';
import { repoSlug, useGitHubStatus } from './gitPublish';

export type PublishRequest = (
  { readonly kind: 'new'; readonly repoName: string; readonly isPrivate: boolean } | { readonly kind: 'existing'; readonly repository: string }
) & { readonly onStep: (step: string) => void };
interface Props {
  readonly projectPath: string;
  readonly defaultName: string;
  readonly branch: string;
  readonly onClose: () => void;
  readonly onPublish: (request: PublishRequest) => Promise<Result<string | undefined, string>>;
  readonly openExternal: (url: string) => void;
}
type PublishState =
  | { readonly kind: 'form'; readonly error?: string }
  | { readonly kind: 'publishing'; readonly step: string }
  | { readonly kind: 'done'; readonly url: string | undefined };
type Preflight = ReturnType<typeof useGitHubStatus>;

// Project ownership resets both the form and any pending publication callbacks.
export default function PublishModal(props: Props) {
  return <PublishDialog key={props.projectPath} {...props} />;
}
function usePublishForm({ defaultName, onPublish, projectPath }: Props) {
  const [name, setName] = useState(() =>
    defaultName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  );
  const [kind, setKind] = useState<'new' | 'existing'>('new');
  const [isPrivate, setIsPrivate] = useState(true);
  const preflight = useGitHubStatus(projectPath);
  const [state, setState] = useState<PublishState>({ kind: 'form' });
  // The ref closes the same-event gap before React renders disabled controls.
  const running = useRef(false);
  const lifetime = useRef<'active' | 'disposed'>('active');
  useEffect(
    () => () => {
      lifetime.current = 'disposed';
    },
    [],
  );
  const ready = preflight.kind === 'ready' && preflight.status.authed;
  const go = async () => {
    if (running.current || !ready || !name.trim()) {
      return;
    }
    if (kind === 'existing') {
      try {
        parseGitHubRepository(name.trim());
      } catch {
        setState({ kind: 'form', error: 'Enter a repository as owner/name.' });
        return;
      }
    }
    running.current = true;
    setState({ kind: 'publishing', step: 'Preparing…' });
    try {
      const result = await onPublish({
        ...(kind === 'new' ? { kind, repoName: name.trim(), isPrivate } : { kind, repository: name.trim() }),
        onStep: (step) => {
          if (lifetime.current === 'active') {
            setState({ kind: 'publishing', step });
          }
        },
      });
      if (lifetime.current === 'active') {
        setState(result.ok ? { kind: 'done', url: result.value } : { kind: 'form', error: result.error });
      }
    } finally {
      running.current = false;
    }
  };
  return { name, setName, kind, setKind, isPrivate, setIsPrivate, preflight, state, ready, go };
}
type Form = ReturnType<typeof usePublishForm>;
function PublishDialog(props: Props) {
  const form = usePublishForm(props);
  const publishing = form.state.kind === 'publishing';
  return (
    <Popup className="modal" onClose={props.onClose} dismissible={!publishing}>
      {({ close }) => (
        <>
          <div className="modal-header">{form.state.kind === 'done' ? 'Published to GitHub' : 'Publish to GitHub'}</div>
          {form.state.kind === 'done' ? (
            <PublishDone {...props} onClose={close} name={form.name} url={form.state.url} />
          ) : (
            <>
              <div className="modal-body">
                <PublishFields form={form} />
                <PublishPreflight preflight={form.preflight} />
                <PublishProgress form={form} branch={props.branch} />
              </div>
              <PublishFooter form={form} onClose={close} />
            </>
          )}
        </>
      )}
    </Popup>
  );
}
function PublishDone({
  name,
  branch,
  url,
  openExternal,
  onClose,
}: Pick<Props, 'branch' | 'openExternal' | 'onClose'> & {
  readonly name: string;
  readonly url: string | undefined;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="publish-done">
          <CheckIcon size={14} />
          <span>
            {name} is on GitHub and <strong>{branch}</strong> has been pushed.
          </span>
        </div>
        {url && (
          <button className="repo-link" onClick={() => openExternal(url)}>
            <span className="repo-slug">{repoSlug(url)}</span>
            <ExternalIcon size={11} />
          </button>
        )}
      </div>
      <div className="modal-footer">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
// The app's own menu rather than a native select, so the dialog matches every other menu.
const DESTINATION_OPTIONS: readonly DropdownOption<'new' | 'existing'>[] = [
  { value: 'new', label: 'Create a new repository' },
  { value: 'existing', label: 'Use an existing repository' },
];
function PublishFields({ form }: { readonly form: Form }) {
  const publishing = form.state.kind === 'publishing';
  return (
    <>
      <Dropdown<'new' | 'existing'>
        ariaLabel="Repository destination"
        value={form.kind}
        disabled={publishing}
        options={DESTINATION_OPTIONS}
        livePreview={false}
        onChange={(kind) => {
          form.setKind(kind);
          form.setName('');
        }}
      />
      {form.kind === 'existing' ? (
        <RepositoryPicker value={form.name} onChange={form.setName} disabled={publishing} />
      ) : (
        <>
          <div>
            <label>Repository name</label>
            <input
              autoFocus
              maxLength={BOUNDARY_LIMITS.textLengthMax}
              value={form.name}
              disabled={publishing}
              onChange={(event) => form.setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void form.go();
                }
              }}
            />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.isPrivate} disabled={publishing} onChange={(event) => form.setIsPrivate(event.target.checked)} />
            Private repository
          </label>
        </>
      )}
    </>
  );
}
function PublishPreflight({ preflight }: { readonly preflight: Preflight }) {
  if (preflight.kind === 'loading') {
    return <div className="hint-text">Checking GitHub CLI…</div>;
  }
  if (preflight.kind === 'error') {
    return <ErrorToast message={preflight.error} />;
  }
  if (!preflight.status.installed) {
    return <ErrorToast message={'GitHub CLI (gh) isn’t installed. Install it from cli.github.com, ' + 'then run gh auth login.'} />;
  }
  if (!preflight.status.authed) {
    return <ErrorToast message={'GitHub CLI isn’t signed in. Run gh auth login in a terminal, ' + 'then reopen this dialog.'} />;
  }
  return undefined;
}
function PublishProgress({ form, branch }: { readonly form: Form; readonly branch: string }) {
  if (form.state.kind === 'publishing') {
    return (
      <div className="publish-progress">
        <span className="mini-spinner" />
        <span>{form.state.step}</span>
      </div>
    );
  }
  if (form.state.kind === 'form') {
    if (form.state.error) {
      return <ErrorToast message={form.state.error} />;
    }
    if (form.preflight.kind === 'ready') {
      const status = form.preflight.status;
      if (status.authed) {
        return (
          <div className="hint-text">
            {form.kind === 'existing'
              ? 'Commits changes and pushes without overwriting remote history.'
              : `Creates a ${form.isPrivate ? 'private' : 'public'} repository and pushes`}{' '}
            <strong>{branch}</strong>
            {status.user ? ` to ${status.user}` : ''}.
          </div>
        );
      }
    }
  }
  return undefined;
}
function PublishFooter({ form, onClose }: { readonly form: Form; readonly onClose: () => void }) {
  const publishing = form.state.kind === 'publishing';
  const error = form.state.kind === 'form' && form.state.error;
  return (
    <div className="modal-footer">
      <button onClick={onClose} disabled={publishing}>
        Cancel
      </button>
      <button className="primary" disabled={!form.name.trim() || !form.ready || publishing} onClick={() => void form.go()}>
        {publishing ? 'Publishing…' : error ? 'Try again' : 'Publish'}
      </button>
    </div>
  );
}
