import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import { readMetadata } from '../../ipc/projectMetadataBridge';
import { parsePublishSource } from '../../../shared/properties/publishConfig';
import { PublishStatus } from '../../features/publishing/PublishStatus';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parsePublishCommitMessage, type PublishTarget } from '../../../shared/properties/publishConfig';
import type { DesktopPublishState } from '../../../shared/properties/publishState';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';
import { PublishControl } from '../../features/publishing/PublishControl';
import { startPublish, readPublishState } from '../../features/publishing/publishBridge';
import { cleanError } from '../../lib/cleanError';
import { readGitInfo } from '../../features/git/gitChipBridge';
import { PublishRepositorySetup } from '../../features/git/PublishRepositorySetup';
import { BranchIndicator } from '../../features/git/BranchIndicator';
import { RefreshGitWhenAiTurnEnds } from './RefreshGitWhenAiTurnEnds';
import { usePublishBranchGate } from '../../features/git/PublishBranchWarning';
import { createPortal } from 'react-dom';
import { usePublishAvailability } from './usePublishAvailability';
import type { SaveState } from '../../editor/saveState';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { setUpWorker } from '../../features/publishing/setUpWorker';
import { reportActionToast, reportErrorToast } from '../../ui/errorNotices';
import { useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

// The step shown before the main process reports one: its reference lets the status panel word it in the language on screen.
const PREPARING = described('publish.status.preparing');
const PREPARING_STATE: DesktopPublishState = { kind: 'running', step: PREPARING.message, stepRef: PREPARING.messageRef };

interface Props {
  readonly projectPath: string;
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly saveState: SaveState | undefined;
  readonly repository: IpcResults['git:info'] | undefined;
  /** Opens the panel that holds the branch switcher; the branch chip beside Publish is a button for it. */
  readonly onOpenBranches?: (() => void) | undefined;
  /** The app's wrapper around a branch change, and what to reload after one (used when Publish offers to switch first). */
  readonly withBranchChange?: (<Value>(work: () => Promise<Value>) => Promise<Value>) | undefined;
  readonly onBranchSwitched?: (() => Promise<unknown>) | undefined;
  /** Drawn just before the branch chip (the pull button), so Publish and the chip hold still as it comes and goes. */
  readonly beforeBranch?: ReactNode;
}

export function DesktopPublishButton(props: Props) {
  return <DesktopPublishSession key={props.projectPath} {...props} />;
}

function DesktopPublishSession(props: Props) {
  const { projectPath, flushSave, refresh, saveState, repository, onOpenBranches, withBranchChange, onBranchSwitched } = props;
  const [state, setState] = useState<DesktopPublishState>({ kind: 'idle' });
  const [settingsRevision, setSettingsRevision] = useState(0);
  const action = useDesktopPublishAction({ projectPath, flushSave, refresh }, state, setState);
  const availability = usePublishAvailability(projectPath, state.kind, saveState, repository, settingsRevision);
  usePublishPolling(projectPath, state, setState, refresh);
  // Every way of starting a publish passes through the gate, so a branch nobody chose is asked about before anything is sent.
  const gate = usePublishBranchGate({ projectPath, repository, flushSave, refresh, withBranchChange, onBranchSwitched });
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  // The dialog's "Set up Cloudflare": the same setup Add Worker runs, for the saved Worker. Success closes the dialog
  // and offers to publish again from the toast; a refusal is a toast that says what and why.
  async function setUpSavedWorker(): Promise<void> {
    try {
      const problem = await setUpSavedPublishWorker(projectPath, translate);
      if (problem === undefined) {
        action.setVisible(false);
        setState({ kind: 'idle' });
        setSettingsRevision((revision) => revision + 1);
        const target = action.lastTarget.current;
        reportActionToast(translate('publish.worker.setup.done'), 'success', [
          { label: translate('publish.label'), run: () => gate.guard(() => void action.publish(target)) },
        ]);
      } else {
        reportErrorToast(translateDescribed(problem));
      }
    } catch (failure: unknown) {
      reportErrorToast(cleanError(failure));
    }
  }
  return (
    <div className="stacki-publish-control stacki-publish-cluster">
      {props.beforeBranch}
      <BranchIndicator projectPath={projectPath} info={repository} onOpen={onOpenBranches} />
      <RefreshGitWhenAiTurnEnds refresh={refresh} />
      <PublishControl
        projectPath={projectPath}
        busy={action.starting || state.kind === 'running' || action.setup !== undefined}
        availability={availability}
        settingsClosed={() => setSettingsRevision((revision) => revision + 1)}
        publish={(target) => gate.guard(() => void action.publish(target))}
      />
      {gate.dialog}
      {(action.visible || state.kind === 'running') && (
        <PublishStatus state={action.starting ? PREPARING_STATE : state} close={() => action.setVisible(false)} setUpWorker={setUpSavedWorker} />
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
  const lastTarget = useRef<PublishTarget>('all');
  const active = usePublishLifetime();
  async function publish(target: PublishTarget, message?: string) {
    if (running.current || state.kind === 'running') {
      return;
    }
    running.current = true;
    lastTarget.current = target;
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
  return { starting, visible, setVisible, setup, setSetup, publish, lastTarget };
}

/** Sets up the saved Worker; undefined when it is ready, else the sentence that says why it is not. */
async function setUpSavedPublishWorker(projectPath: string, translate: Translator): Promise<Described | undefined> {
  const config = parsePublishSource((await readMetadata(projectPath, 'publish')).source);
  if (config.hosting.provider !== 'cloudflare-workers') {
    // The settings changed since the publish failed; a Worker is no longer the destination.
    return { message: translate('publish.worker.setup.needed') };
  }
  const result = await setUpWorker(projectPath, { accountId: config.hosting.accountId, project: config.hosting.project });
  return result.ok ? undefined : result.error;
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
  const translate = useTranslate();
  const [message, setMessage] = useState('');
  return (
    <Popup className="modal publish-commit-message" label={translate('shell.publish.commitTitle')} onClose={close}>
      {({ close: dismiss }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(parsePublishCommitMessage(message));
          }}
        >
          <div className="modal-header">{translate('shell.publish.commitTitle')}</div>
          <div className="modal-body">
            <p>{translate('shell.publish.commitBody')}</p>
            <label>
              {translate('shell.publish.commitMessage')}
              <textarea
                autoFocus
                required
                maxLength={4000}
                rows={3}
                value={message}
                placeholder={translate('shell.publish.commitPlaceholder')}
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={dismiss}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary" disabled={message.trim().length === 0}>
              {translate('shell.publish.commitAndPush')}
            </button>
          </div>
        </form>
      )}
    </Popup>
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
