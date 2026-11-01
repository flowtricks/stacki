import Popup from '../../ui/Popup';
import { readMetadata } from '../../ipc/projectMetadataBridge';
import { parsePublishSource } from '../../../shared/properties/publishConfig';
import { CheckIcon, CloseIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from '../../features/publishing/PublishProviderIcon';
import { useEffect, useRef, useState } from 'react';
import { parsePublishCommitMessage, type PublishTarget } from '../../../shared/properties/publishConfig';
import type { DesktopPublishState } from '../../../shared/properties/publishState';
import { PublishControl } from '../../features/publishing/PublishControl';
import { startPublish, readPublishState } from '../../features/publishing/publishBridge';
import { cleanError } from '../../lib/cleanError';
import { readGitInfo } from '../../features/git/gitChipBridge';
import { PublishRepositorySetup } from '../../features/git/PublishRepositorySetup';
import { createPortal } from 'react-dom';
import { usePublishAvailability } from './usePublishAvailability';
import type { SaveState } from '../../editor/saveState';
import type { IpcResults } from '../../../shared/ipc/ipcResults';

interface Props {
  readonly projectPath: string;
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly saveState: SaveState | undefined;
  readonly repository: IpcResults['git:info'] | undefined;
}

export function DesktopPublishButton(props: Props) {
  return <DesktopPublishSession key={props.projectPath} {...props} />;
}

function DesktopPublishSession({ projectPath, flushSave, refresh, saveState, repository }: Props) {
  const [state, setState] = useState<DesktopPublishState>({ kind: 'idle' });
  const [settingsRevision, setSettingsRevision] = useState(0);
  const action = useDesktopPublishAction({ projectPath, flushSave, refresh }, state, setState);
  const availability = usePublishAvailability(projectPath, state.kind, saveState, repository, settingsRevision);
  usePublishPolling(projectPath, state, setState, refresh);
  return (
    <div className="stacki-publish-control">
      <PublishControl
        projectPath={projectPath}
        busy={action.starting || state.kind === 'running' || action.setup !== undefined}
        availability={availability}
        settingsClosed={() => setSettingsRevision((revision) => revision + 1)}
        publish={(target) => void action.publish(target)}
      />
      {(action.visible || state.kind === 'running') && (
        <DesktopPublishStatus state={action.starting ? { kind: 'running', step: 'Preparing publish…' } : state} close={() => action.setVisible(false)} />
      )}
      {action.setup?.kind === 'commit' && (
        <PublishCommitMessage
          close={() => action.setSetup(undefined)}
          submit={(message) => {
            if (action.setup?.kind === 'commit') {
              void action.publish(action.setup.target, message);
            }
          }}
        />
      )}
      {action.setup?.kind === 'repository' &&
        createPortal(<PublishRepositorySetup projectPath={projectPath} flushSave={flushSave} close={() => action.setSetup(undefined)} />, document.body)}
    </div>
  );
}

type PublishSetup = { readonly kind: 'repository' } | { readonly kind: 'commit'; readonly target: PublishTarget };

function useDesktopPublishAction(
  { projectPath, flushSave, refresh }: Pick<Props, 'projectPath' | 'flushSave' | 'refresh'>,
  state: DesktopPublishState,
  setState: (state: DesktopPublishState) => void,
) {
  const [starting, setStarting] = useState(false);
  const [visible, setVisible] = useState(false);
  const [setup, setSetup] = useState<PublishSetup>();
  const running = useRef(false);
  const active = usePublishLifetime();
  async function publish(target: PublishTarget, message?: string) {
    if (running.current || state.kind === 'running') {
      return;
    }
    running.current = true;
    setStarting(true);
    setVisible(false);
    setSetup(undefined);
    try {
      await flushSave();
      const requested = await publishSetup(projectPath, target, message);
      if (!active.current) {
        return;
      }
      if (requested) {
        setSetup(requested);
        return;
      }
      setVisible(true);
      const next = await startPublish(projectPath, target, message);
      if (active.current) {
        setState(next);
      }
      await refresh();
    } catch (error: unknown) {
      if (active.current) {
        setVisible(true);
        setState({ kind: 'failed', message: cleanError(error), github: false, hosting: false });
      }
    } finally {
      running.current = false;
      if (active.current) {
        setStarting(false);
      }
    }
  }
  return { starting, visible, setVisible, setup, setSetup, publish };
}

async function publishSetup(projectPath: string, target: PublishTarget, message: string | undefined): Promise<PublishSetup | undefined> {
  if (target === 'hosting') {
    return undefined;
  }
  const repository = await readGitInfo(projectPath);
  if (!repository.ok) {
    throw new Error(repository.error);
  }
  if (!repository.value.isRepo || !repository.value.remote) {
    return { kind: 'repository' };
  }
  if (repository.value.dirty && message === undefined) {
    const settings = parsePublishSource((await readMetadata(projectPath, 'publish')).source);
    if (settings.githubWorkflow?.kind === 'pull-request') {
      return undefined;
    }
    return { kind: 'commit', target };
  }
  return undefined;
}

export function PublishCommitMessage({ close, submit }: { readonly close: () => void; readonly submit: (message: string) => void }) {
  const [message, setMessage] = useState('');
  return (
    <Popup className="modal publish-commit-message" label="Commit changes" onClose={close}>
      {({ close: dismiss }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(parsePublishCommitMessage(message));
          }}
        >
          <div className="modal-header">Commit changes</div>
          <div className="modal-body">
            <p>Describe your changes before pushing them to GitHub.</p>
            <label>
              Commit message
              <textarea
                autoFocus
                required
                maxLength={4000}
                rows={3}
                value={message}
                placeholder="Describe your changes"
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={dismiss}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={message.trim().length === 0}>
              Commit and push
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}

export function DesktopPublishStatus({ state, close }: { readonly state: DesktopPublishState; readonly close: () => void }) {
  const busy = state.kind === 'idle' || state.kind === 'running';
  const title =
    state.kind === 'review-open'
      ? 'Ready for review'
      : state.kind === 'done'
        ? 'Published successfully'
        : state.kind === 'failed'
          ? 'Publish needs attention'
          : 'Publishing';
  return (
    <Popup className="modal desktop-publish-status" label={title} onClose={close} dismissible={!busy}>
      {({ close: dismiss }) => (
        <>
          <div className="modal-body publish-status-body" data-state={state.kind}>
            <div className="publish-status-symbol" aria-hidden="true">
              {state.kind === 'done' ? <CheckIcon size={24} /> : state.kind === 'failed' ? <CloseIcon size={24} /> : <UploadCloudIcon size={24} />}
            </div>
            <h2>{title}</h2>
            {busy ? (
              <PublishRunning state={state} />
            ) : (
              <>
                {state.kind === 'failed' && <p role="alert">{state.message}</p>}
                {state.kind === 'review-open' && (
                  <p>
                    <a href={state.url} target="_blank" rel="noreferrer">
                      Open pull request
                    </a>{' '}
                    Your live site and current branch are unchanged.
                  </p>
                )}
                <PublishResults state={state} />
              </>
            )}
          </div>
          <div className="modal-footer">
            {busy ? (
              <span>Keep Stacki open until publishing finishes.</span>
            ) : (
              <button className="primary" onClick={dismiss}>
                {state.kind === 'done' ? 'Done' : 'Close'}
              </button>
            )}
          </div>
        </>
      )}
    </Popup>
  );
}

function PublishRunning({ state }: { readonly state: DesktopPublishState }) {
  const message = state.kind === 'running' ? state.step : 'Preparing publish…';
  const progress = state.kind === 'running' ? state.progress : undefined;
  return (
    <div className="publish-status-running" aria-busy="true">
      <p role="status" aria-live="polite">
        {message}
      </p>
      <progress max={progress?.total ?? 1} value={progress?.completed} aria-label="Publish progress" aria-valuetext={message} />
      <small>{progress ? `Step ${progress.completed + 1} of ${progress.total}` : 'Preparing your project'}</small>
    </div>
  );
}

function PublishResults({ state }: { readonly state: DesktopPublishState }) {
  if (state.kind !== 'done' && state.kind !== 'failed') {
    return undefined;
  }
  return (
    <div className="publish-status-results" role="status" aria-live="polite">
      {state.github && (
        <div>
          <PublishProviderIcon provider="github" />
          <span>Changes pushed to GitHub</span>
          <CheckIcon size={14} />
        </div>
      )}
      {state.hosting && (
        <div>
          <UploadCloudIcon />
          <span>Hosting deployment completed</span>
          <CheckIcon size={14} />
        </div>
      )}
    </div>
  );
}

function usePublishPolling(projectPath: string, state: DesktopPublishState, setState: (state: DesktopPublishState) => void, refresh: () => Promise<unknown>) {
  useEffect(() => {
    let disposed = false;
    void readPublishState(projectPath)
      .then((next) => {
        if (!disposed) {
          setState(next);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [projectPath, setState]);
  useEffect(() => {
    if (state.kind !== 'running') {
      return undefined;
    }
    let disposed = false;
    const poll = async () => {
      try {
        const next = await readPublishState(projectPath);
        if (!disposed) {
          setState(next);
          if (next.kind !== 'running') {
            await refresh();
          }
        }
      } catch (error: unknown) {
        if (!disposed) {
          setState({ kind: 'failed', message: cleanError(error), github: false, hosting: false });
        }
      }
    };
    // Each response schedules the next effect; requests never overlap.
    const timer = setTimeout(() => {
      void poll();
    }, 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [projectPath, state, setState, refresh]);
}

function usePublishLifetime() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}
