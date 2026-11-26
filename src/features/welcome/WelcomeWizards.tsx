import { CodeInline } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createAstroProject, createStarterProject, subscribeCreateLog, type ProjectTemplate } from './welcomeBridge';
import { CREATE_PACKAGE_MANAGERS, packageManagerLabel, type CreatePackageManager } from '../../../shared/properties/packageManager';
import { parseStarterName } from '../../../shared/ipc/shadcnStarter';
import Dropdown from '../../ui/Dropdown';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import './welcomeWizards.css';

const CREATE_LOG_CHARS_MAX = 20_000;
export const SITE_NAME_DEFAULT = 'my-site';
const SITE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const TEMPLATES = [
  { value: 'basics', labelKey: 'welcome.template.basics.label', hintKey: 'welcome.template.basics.hint' },
  { value: 'blog', labelKey: 'welcome.template.blog.label', hintKey: 'welcome.template.blog.hint' },
  { value: 'starlight', labelKey: 'welcome.template.starlight.label', hintKey: 'welcome.template.starlight.hint' },
  { value: 'minimal', labelKey: 'welcome.template.minimal.label', hintKey: 'welcome.template.minimal.hint' },
] as const satisfies readonly {
  readonly value: ProjectTemplate;
  readonly labelKey: MessageKey;
  readonly hintKey: MessageKey;
}[];

export type RunState = { readonly kind: 'idle' } | { readonly kind: 'running' } | { readonly kind: 'error'; readonly message: string };

export interface WizardProps {
  readonly onClose: () => void;
  readonly onDone: (directory: string) => void;
}

export function StarterWizard({ parentPath, onClose, onDone }: WizardProps & { readonly parentPath: string }) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const [name, setName] = useState(SITE_NAME_DEFAULT);
  const [manager, setManager] = useState<CreatePackageManager>('npm');
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const log = useCreateLog();
  const cleanName = name.trim();
  const invalid = !siteNameValid(name);
  const running = state.kind === 'running';
  const run = async (): Promise<void> => {
    if (invalid || !log.begin()) {
      return;
    }
    setState({ kind: 'running' });
    const result = await createStarterProject({ starter: 'lumos', parentPath, name: cleanName, packageManager: manager });
    log.end();
    if (!result.ok) {
      setState({ kind: 'error', message: result.error });
    } else if (!result.value.ok) {
      setState({ kind: 'error', message: translate('welcome.starter.unfinished') });
    } else {
      onDone(result.value.projectPath);
    }
  };
  return (
    <WizardFrame
      title={translate('welcome.starter.title')}
      running={running}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="ghost" onClick={close} disabled={running}>
            {translate('ui.cancel')}
          </button>
          <button className="primary" onClick={() => void run()} disabled={running || invalid}>
            {running ? translate('welcome.creating') : translate('welcome.starter.submit')}
          </button>
        </>
      )}
    >
      <SiteNameField parentPath={parentPath} name={name} running={running} change={setName} submit={() => void run()} />
      <PackageManagerField value={manager} disabled={running} change={setManager} />
      <div className="starter-note">
        {translateRich(manager === 'npm' ? 'welcome.starter.note' : 'welcome.starter.noteWithManager', {
          command: <CodeInline language="shell" text="npm create lumos@latest" />,
          manager: <CodeInline language="shell" text={manager} />,
        })}
      </div>
      {(running || log.text) && <CreateLog log={log.text} running={running} elementRef={log.elementRef} />}
      {state.kind === 'error' && <ErrorToast message={state.message} />}
    </WizardFrame>
  );
}

export function NewProjectWizard({ parentPath, onClose, onDone }: WizardProps & { readonly parentPath: string }) {
  const translate = useTranslate();
  const [name, setName] = useState(SITE_NAME_DEFAULT);
  const [template, setTemplate] = useState<ProjectTemplate>('basics');
  const [install, setInstall] = useState(true);
  const [git, setGit] = useState(true);
  const [ai, setAi] = useState(false);
  const [packageManager, setPackageManager] = useState<CreatePackageManager>('npm');
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const log = useCreateLog();
  const running = state.kind === 'running';
  const invalid = !siteNameValid(name);
  const run = async (): Promise<void> => {
    if (invalid || !log.begin()) {
      return;
    }
    setState({ kind: 'running' });
    const options = { parentPath, name: name.trim(), template, install, git, ai, packageManager };
    const result = await createAstroProject(options);
    log.end();
    if (result.ok) {
      onDone(result.value.projectPath);
    } else {
      setState({ kind: 'error', message: result.error });
    }
  };
  return (
    <WizardFrame
      title={translate('welcome.project.title')}
      running={running}
      onClose={onClose}
      footer={(close) => (
        <>
          <button onClick={close} disabled={running}>
            {state.kind === 'error' ? translate('ui.close') : translate('ui.cancel')}
          </button>
          <button className="primary" onClick={() => void run()} disabled={running || invalid}>
            {running ? translate('welcome.creating') : state.kind === 'error' ? translate('welcome.project.tryAgain') : translate('welcome.project.submit')}
          </button>
        </>
      )}
    >
      <SiteNameField parentPath={parentPath} name={name} running={running} change={setName} submit={() => void run()} />
      {state.kind === 'idle' && (
        <ProjectChoices
          template={template}
          install={install}
          git={git}
          ai={ai}
          manager={packageManager}
          setManager={setPackageManager}
          setTemplate={setTemplate}
          setInstall={setInstall}
          setGit={setGit}
          setAi={setAi}
        />
      )}
      {state.kind !== 'idle' && <CreateLog log={log.text || translate('welcome.project.starting')} running={running} elementRef={log.elementRef} />}
      {state.kind === 'error' && <ErrorToast message={state.message} />}
    </WizardFrame>
  );
}

// The main process checks the same rules (newSiteDirectory in electron/project/starter.ts).
function siteNameValid(name: string): boolean {
  const cleanName = name.trim();
  if (cleanName.length === 0) {
    return false;
  }
  return SITE_NAME_PATTERN.test(cleanName);
}

export function starterNameProblem(name: string): 'welcome.starter.nameEmpty' | 'welcome.starter.nameInvalid' | undefined {
  if (name.trim() === '') {
    return 'welcome.starter.nameEmpty';
  }
  try {
    parseStarterName(name);
    return undefined;
  } catch {
    return 'welcome.starter.nameInvalid';
  }
}

// Each wizard uses the same name field and path preview.
// Enter submits only a valid name and only while nothing is running.
export function SiteNameField(props: {
  readonly parentPath: string;
  readonly name: string;
  readonly running: boolean;
  readonly change: (name: string) => void;
  readonly submit: () => void;
  readonly pathLabel?: string;
  readonly problem?: string | undefined;
}) {
  const translate = useTranslate();
  const inputId = useId();
  const problemId = useId();
  const folder = siteFolderPath(props.parentPath, props.name.trim() || SITE_NAME_DEFAULT);
  return (
    <>
      <div className="starter-field">
        <label className="starter-field-label" htmlFor={inputId}>
          {translate('welcome.siteName')}
        </label>
        <input
          id={inputId}
          autoFocus
          value={props.name}
          spellCheck={false}
          disabled={props.running}
          maxLength={255}
          aria-invalid={props.problem !== undefined || undefined}
          aria-describedby={props.problem === undefined ? undefined : problemId}
          onChange={(event) => props.change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') {
              return;
            }
            if (props.problem === undefined && siteNameValid(props.name)) {
              props.submit();
            }
          }}
        />
      </div>
      {props.pathLabel === undefined ? (
        <div className="new-project-dir" title={folder}>
          {folder}
        </div>
      ) : (
        <label className="starter-field">
          {/* Use the path caption for name feedback so validation keeps the fields in place. */}
          <span id={problemId} aria-live="polite" data-invalid={props.problem !== undefined}>
            {props.problem ?? props.pathLabel}
          </span>
          <input className="starter-project-path" aria-label={props.pathLabel} dir="ltr" readOnly value={folder} title={folder} />
        </label>
      )}
    </>
  );
}

function siteFolderPath(parentPath: string, name: string): string {
  // The native picker returns platform paths, including a drive or share on Windows.
  const windowsPath = /^[A-Za-z]:\\|^\\\\/.test(parentPath);
  const separator = windowsPath ? '\\' : '/';
  return parentPath.endsWith(separator) ? parentPath + name : parentPath + separator + name;
}

// The manager that installs the new site. The main process checks it is installed first.
export function PackageManagerField(props: {
  readonly value: CreatePackageManager;
  readonly disabled: boolean;
  readonly change: (manager: CreatePackageManager) => void;
}) {
  const translate = useTranslate();
  return (
    <div className="starter-field">
      <span>{translate('welcome.packageManager')}</span>
      <Dropdown
        ariaLabel={translate('welcome.packageManager')}
        value={props.value}
        disabled={props.disabled}
        livePreview={false}
        options={CREATE_PACKAGE_MANAGERS.map((manager) => ({
          value: manager,
          label: packageManagerLabel(manager),
        }))}
        onChange={props.change}
      />
    </div>
  );
}

/** The scaffolder's and installer's output as it streams on `create:log`, bounded and kept scrolled to the end. */
export function useCreateLog() {
  const [text, setText] = useState('');
  const active = useRef(false);
  const elementRef = useRef<HTMLPreElement>(null);
  useEffect(
    () =>
      subscribeCreateLog((chunk) => {
        if (active.current) {
          setText((previous) => (previous + chunk).slice(-CREATE_LOG_CHARS_MAX));
        }
      }),
    [],
  );
  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.scrollTop = elementRef.current.scrollHeight;
    }
  }, [text]);
  return {
    text,
    elementRef,
    begin: () => {
      // Input events can arrive before React has disabled the controls.
      if (active.current) {
        return false;
      }
      active.current = true;
      setText('');
      return true;
    },
    end: () => {
      active.current = false;
    },
  };
}

export function WizardFrame({
  title,
  running,
  onClose,
  children,
  footer,
  className,
}: {
  readonly title: string;
  readonly running: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly footer: (close: () => void) => React.ReactNode;
  readonly className?: string;
}) {
  return (
    <Popup className={className ? 'modal new-project-modal ' + className : 'modal new-project-modal'} onClose={onClose} dismissible={!running} label={title}>
      {({ close }) => (
        <>
          <div className="modal-header">{title}</div>
          <div className="modal-body">{children}</div>
          <div className="modal-footer">{footer(close)}</div>
        </>
      )}
    </Popup>
  );
}

interface ProjectChoicesProps {
  readonly template: ProjectTemplate;
  readonly install: boolean;
  readonly git: boolean;
  readonly ai: boolean;
  readonly manager: CreatePackageManager;
  readonly setManager: (manager: CreatePackageManager) => void;
  readonly setTemplate: (template: ProjectTemplate) => void;
  readonly setInstall: (value: boolean) => void;
  readonly setGit: (value: boolean) => void;
  readonly setAi: (value: boolean) => void;
}

function ProjectChoices(props: ProjectChoicesProps) {
  const translate = useTranslate();
  return (
    <>
      <div>
        <label>{translate('welcome.project.question')}</label>
        <div className="template-list">
          {TEMPLATES.map((template) => (
            <div
              key={template.value}
              className={`template-option ${props.template === template.value ? 'on' : ''}`}
              onClick={() => props.setTemplate(template.value)}
            >
              <div className="template-name">{translate(template.labelKey)}</div>
              <div className="template-hint">{translate(template.hintKey)}</div>
            </div>
          ))}
        </div>
      </div>
      <PackageManagerField value={props.manager} disabled={!props.install} change={props.setManager} />
      <CheckRow label={translate('welcome.project.install')} checked={props.install} change={props.setInstall} />
      <CheckRow label={translate('welcome.project.git')} checked={props.git} change={props.setGit} />
      <CheckRow label={translate('welcome.project.ai')} checked={props.ai} change={props.setAi} />
    </>
  );
}

function CheckRow({ label, checked, change }: { readonly label: string; readonly checked: boolean; readonly change: (value: boolean) => void }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(event) => change(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

// While it runs, dots animate after the last line, as a terminal shows work in progress:
// installs and downloads can print nothing for a long time.
export function CreateLog({
  log,
  running,
  elementRef,
}: {
  readonly log: string;
  readonly running: boolean;
  readonly elementRef: React.RefObject<HTMLPreElement>;
}) {
  const translate = useTranslate();
  return (
    <pre className="create-log" ref={elementRef}>
      {running ? log.trimEnd() : log}
      {running && <span className="create-log-dots" aria-label={translate('welcome.working')} />}
    </pre>
  );
}
