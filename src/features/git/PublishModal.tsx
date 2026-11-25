import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import RepositoryPicker from '../../ui/RepositoryPicker';
import { parseGitHubRepository } from '../../../shared/ipc/githubRepository';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Failure } from '../../lib/cleanError';
import { translateFailure, translateReference } from '../../lib/i18n/translateErrorText';
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
  readonly onPublish: (request: PublishRequest) => Promise<PublishResult>;
  readonly openExternal: (url: string) => void;
}
/** The new repository's address, or why publishing failed (`errorRef` names our own sentence for translation). */
export type PublishResult = { readonly ok: true; readonly value: string | undefined } | Failure;
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
  const translate = useTranslate();
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
        setState({ kind: 'form', error: translate('git.publish.invalidRepository') });
        return;
      }
    }
    running.current = true;
    setState({ kind: 'publishing', step: translate('git.publish.preparing') });
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
        setState(result.ok ? { kind: 'done', url: result.value } : { kind: 'form', error: translateFailure(result, translate) });
      }
    } finally {
      running.current = false;
    }
  };
  return { name, setName, kind, setKind, isPrivate, setIsPrivate, preflight, state, ready, go };
}
type Form = ReturnType<typeof usePublishForm>;
function PublishDialog(props: Props) {
  const translate = useTranslate();
  const form = usePublishForm(props);
  const publishing = form.state.kind === 'publishing';
  return (
    <Popup className="modal" onClose={props.onClose} dismissible={!publishing}>
      {({ close }) => (
        <>
          <div className="modal-header">{form.state.kind === 'done' ? translate('git.publish.published') : translate('git.publish.title')}</div>
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
  const translateRich = useTranslateRich();
  const translate = useTranslate();
  return (
    <>
      <div className="modal-body">
        <div className="publish-done">
          <CheckIcon size={14} />
          <span>{translateRich('git.publish.doneBody', { name, branch, strong: (text) => <strong>{text}</strong> })}</span>
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
          {translate('git.done')}
        </button>
      </div>
    </>
  );
}
// The app's own menu rather than a native select, so the dialog matches every other menu.
function destinationOptions(translate: Translator): readonly DropdownOption<'new' | 'existing'>[] {
  return [
    { value: 'new', label: translate('git.publish.destinationNew') },
    { value: 'existing', label: translate('git.publish.destinationExisting') },
  ];
}
function PublishFields({ form }: { readonly form: Form }) {
  const translate = useTranslate();
  const publishing = form.state.kind === 'publishing';
  return (
    <>
      <Dropdown<'new' | 'existing'>
        ariaLabel={translate('git.publish.destination')}
        value={form.kind}
        disabled={publishing}
        options={destinationOptions(translate)}
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
            <label>{translate('git.publish.repositoryName')}</label>
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
            {translate('git.publish.private')}
          </label>
        </>
      )}
    </>
  );
}
function PublishPreflight({ preflight }: { readonly preflight: Preflight }) {
  const translate = useTranslate();
  if (preflight.kind === 'loading') {
    return <div className="hint-text">{translate('git.publish.checkingCli')}</div>;
  }
  if (preflight.kind === 'error') {
    return <ErrorToast message={translateReference(preflight.error, preflight.errorRef, translate)} />;
  }
  if (!preflight.status.installed) {
    return <ErrorToast message={translate('git.publish.cliMissing')} />;
  }
  if (!preflight.status.authed) {
    return <ErrorToast message={translate('git.publish.cliSignedOut')} />;
  }
  return undefined;
}
function PublishProgress({ form, branch }: { readonly form: Form; readonly branch: string }) {
  const translateRich = useTranslateRich();
  const translate = useTranslate();
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
      const hintParams = { branch, user: status.user ?? '', strong: (text: ReactNode) => <strong>{text}</strong> };
      if (status.authed) {
        return (
          <div className="hint-text">
            {form.kind === 'existing'
              ? translate('git.publish.hintExisting')
              : translateRich(newHintKey({ isPrivate: form.isPrivate, user: status.user }), hintParams)}
          </div>
        );
      }
    }
  }
  return undefined;
}
// Each wording is one whole message: where "to {user}" sits differs between languages, so it is never appended.
function newHintKey(options: { readonly isPrivate: boolean; readonly user: string | undefined }): MessageKey {
  const { isPrivate, user } = options;
  if (isPrivate) {
    return user ? 'git.publish.hintPrivateTo' : 'git.publish.hintPrivate';
  }
  return user ? 'git.publish.hintPublicTo' : 'git.publish.hintPublic';
}
function PublishFooter({ form, onClose }: { readonly form: Form; readonly onClose: () => void }) {
  const translate = useTranslate();
  const publishing = form.state.kind === 'publishing';
  const error = form.state.kind === 'form' && form.state.error;
  return (
    <div className="modal-footer">
      <button onClick={onClose} disabled={publishing}>
        {translate('ui.cancel')}
      </button>
      <button className="primary" disabled={!form.name.trim() || !form.ready || publishing} onClick={() => void form.go()}>
        {publishing ? translate('git.publish.submitting') : error ? translate('git.publish.tryAgain') : translate('git.publish.submit')}
      </button>
    </div>
  );
}
