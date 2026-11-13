import { CodeInline } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import React, { useEffect, useRef, useState } from 'react';
import { createAstroProject, createStarterProject, subscribeCreateLog, type ProjectTemplate } from './welcomeBridge';
import { CREATE_PACKAGE_MANAGERS, packageManagerLabel, type CreatePackageManager } from '../../../shared/properties/packageManager';
import Dropdown from '../../ui/Dropdown';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';

const CREATE_LOG_CHARS_MAX = 20_000;
const SITE_NAME_DEFAULT = 'my-site';
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

type RunState = { readonly kind: 'idle' } | { readonly kind: 'running' } | { readonly kind: 'error'; readonly message: string };

interface WizardProps {
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
    setState({ kind: 'running' });
    log.clear();
    const result = await createStarterProject(parentPath, cleanName, manager);
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
    setState({ kind: 'running' });
    log.clear();
    const options = { parentPath, name: name.trim(), template, install, git, ai, packageManager };
    const result = await createAstroProject(options);
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

// The site's name and the folder it becomes, shared by both wizards so they name sites alike.
// Enter submits only a valid name and only while nothing is running.
function SiteNameField(props: {
  readonly parentPath: string;
  readonly name: string;
  readonly running: boolean;
  readonly change: (name: string) => void;
  readonly submit: () => void;
}) {
  const translate = useTranslate();
  const folder = `${props.parentPath}/${props.name.trim() || SITE_NAME_DEFAULT}`;
  return (
    <>
      <label className="starter-field">
        <span>{translate('welcome.siteName')}</span>
        <input
          autoFocus
          value={props.name}
          spellCheck={false}
          disabled={props.running}
          maxLength={255}
          onChange={(event) => props.change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') {
              return;
            }
            if (siteNameValid(props.name)) {
              props.submit();
            }
          }}
        />
      </label>
      <div className="new-project-dir" title={folder}>
        {folder}
      </div>
    </>
  );
}

// The manager that installs the new site. The main process checks it is installed first.
function PackageManagerField(props: {
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

function useCreateLog() {
  const [text, setText] = useState('');
  const elementRef = useRef<HTMLPreElement>(null);
  useEffect(() => subscribeCreateLog((chunk) => setText((previous) => (previous + chunk).slice(-CREATE_LOG_CHARS_MAX))), []);
  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.scrollTop = elementRef.current.scrollHeight;
    }
  }, [text]);
  return { text, elementRef, clear: () => setText('') };
}

function WizardFrame({
  title,
  running,
  onClose,
  children,
  footer,
}: {
  readonly title: string;
  readonly running: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly footer: (close: () => void) => React.ReactNode;
}) {
  return (
    <Popup className="modal new-project-modal" onClose={onClose} dismissible={!running}>
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
function CreateLog({ log, running, elementRef }: { readonly log: string; readonly running: boolean; readonly elementRef: React.RefObject<HTMLPreElement> }) {
  const translate = useTranslate();
  return (
    <pre className="create-log" ref={elementRef}>
      {running ? log.trimEnd() : log}
      {running && <span className="create-log-dots" aria-label={translate('welcome.working')} />}
    </pre>
  );
}
