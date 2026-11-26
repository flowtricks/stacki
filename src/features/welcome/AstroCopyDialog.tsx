// "Make an Astro copy": what "Open from folder" offers for a plain website folder (shared/ipc/astroCopy.ts).
// A name (`<folder>-astro`) and a location (the folder's parent), checked live: a refused value takes the
// error look at once, and its reason arrives as one toast when the person tries to submit, never as a
// row under the field. While the copy runs, the button carries the progress and the log streams below.
import { useEffect, useRef, useState } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import Popup from '../../ui/Popup';
import { FolderIcon } from '../../ui/Icons';
import { reportErrorToast } from '../../ui/errorNotices';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { Formatters } from '../../../shared/core/i18n/format';
import {
  astroCopyNameProblem,
  shortenLocation,
  type AstroCopyCheck,
  type AstroCopyCreated,
  type AstroCopyFailure,
  type AstroCopyTargetProblem,
} from '../../../shared/ipc/astroCopy';
import { checkAstroCopy, chooseStarterParent, createAstroCopy } from './welcomeBridge';
import { CreateLog, useCreateLog } from './WelcomeWizards';

export interface AstroCopySource {
  readonly sourcePath: string;
  readonly parentPath: string;
  readonly name: string;
  readonly homePath: string;
}

interface AstroCopyDialogProps {
  readonly source: AstroCopySource;
  readonly onClose: () => void;
  readonly onDone: (created: AstroCopyCreated) => void;
}

// What a finished copy says before it opens: that it was made, and anything the person should know about it.
export function announceAstroCopy(
  created: AstroCopyCreated,
  translate: Translator,
  showToast: (message: string, kind: 'success' | 'error' | 'info') => void,
): void {
  showToast(translate('welcome.copy.created'), 'success');
  if (created.keptAsFilesCount > 0) {
    showToast(translate('welcome.copy.keptAsFiles', { count: created.keptAsFilesCount, files: created.keptAsFiles.join(', ') }), 'info');
  }
  if (created.install.kind === 'failed') {
    showToast(translate('welcome.copy.installFailed', { detail: created.install.detail }), 'error');
  }
}

// The main process's verdict on one name and location; a verdict for other values is stale.
interface Verdict {
  readonly key: string;
  readonly check: AstroCopyCheck;
}

const NAME_PROBLEMS: ReadonlySet<AstroCopyTargetProblem> = new Set(['name-empty', 'name-invalid', 'target-exists']);

export default function AstroCopyDialog({ source, onClose, onDone }: AstroCopyDialogProps) {
  const translate = useTranslate();
  const format = useFormat();
  const [name, setName] = useState(source.name);
  const [parentPath, setParentPath] = useState(source.parentPath);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const log = useCreateLog();
  const key = `${parentPath}\n${name}`;
  const verdict = useTargetVerdict(source.sourcePath, parentPath, name, key);
  const problem = astroCopyNameProblem(name) ?? (verdict?.key === key && !verdict.check.ok ? verdict.check.error : undefined);
  const checked = verdict?.key === key && verdict.check.ok;
  const ready = problem === undefined && checked && !running;

  useEffect(() => {
    if (!running) {
      inputRef.current?.focus();
    }
  }, [running]);

  const submit = async (): Promise<void> => {
    if (running) {
      return;
    }
    if (problem !== undefined) {
      reportErrorToast(problemMessage(problem, translate));
      return;
    }
    if (!checked) {
      return; // The check of these very values is still on its way; Enter again once it is back.
    }
    if (!log.begin()) {
      return;
    }
    setRunning(true);
    const result = await createAstroCopy({ sourcePath: source.sourcePath, parentPath, name });
    log.end();
    if (!result.ok) {
      reportErrorToast(result.error);
    } else if (!result.value.ok) {
      reportErrorToast(failureMessage(result.value.error, translate, format));
    } else {
      onDone(result.value.value);
      return;
    }
    setRunning(false);
  };

  const chooseLocation = async (): Promise<void> => {
    const result = await chooseStarterParent();
    if (!result.ok) {
      reportErrorToast(result.error);
    } else if (!result.value.canceled) {
      setParentPath(result.value.parentPath);
    }
  };

  const nameRefused = problem !== undefined && NAME_PROBLEMS.has(problem);
  const locationRefused = problem !== undefined && !NAME_PROBLEMS.has(problem);
  return (
    <Popup className="modal new-project-modal astro-copy-modal" onClose={onClose} dismissible={!running} label={translate('welcome.copy.title')}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('welcome.copy.title')}</div>
          <div className="modal-body">
            <div className="starter-note">{translate('welcome.copy.explain')}</div>
            <label className="starter-field">
              <span>{translate('welcome.copy.name')}</span>
              <input
                ref={inputRef}
                autoFocus
                value={name}
                spellCheck={false}
                disabled={running}
                aria-invalid={nameRefused ? true : undefined}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </label>
            <div className="starter-field">
              <span>{translate('welcome.copy.location')}</span>
              <div className="astro-copy-location" aria-invalid={locationRefused ? true : undefined} title={parentPath}>
                <FolderIcon size={12} />
                <CodeInline language="shell" text={shortenLocation(parentPath, source.homePath)} />
                <button type="button" className="ghost" disabled={running} onClick={() => void chooseLocation()}>
                  {translate('welcome.copy.choose')}
                </button>
              </div>
            </div>
            {running && <CreateLog log={log.text || translate('welcome.copy.busy')} running={running} elementRef={log.elementRef} />}
          </div>
          <div className="modal-footer">
            <button onClick={close} disabled={running}>
              {translate('ui.cancel')}
            </button>
            <button className="primary" aria-busy={running ? true : undefined} disabled={!ready} onClick={() => void submit()}>
              {running ? translate('welcome.copy.busy') : translate('welcome.copy.submit')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// The main process's check of the target, asked again whenever the name or location changes. A reply
// for values that have since changed is kept under its own key and never mistaken for the current one.
function useTargetVerdict(sourcePath: string, parentPath: string, name: string, key: string): Verdict | undefined {
  const [verdict, setVerdict] = useState<Verdict | undefined>(undefined);
  useEffect(() => {
    if (astroCopyNameProblem(name) !== undefined) {
      return undefined; // Refused here already; the disk has nothing to add.
    }
    let active = true;
    void checkAstroCopy({ sourcePath, parentPath, name }).then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setVerdict({ key, check: result.value });
      } else {
        reportErrorToast(result.error);
      }
    });
    return () => {
      active = false;
    };
  }, [sourcePath, parentPath, name, key]);
  return verdict;
}

const PROBLEM_KEYS = {
  'name-empty': 'welcome.copy.problem.nameEmpty',
  'name-invalid': 'welcome.copy.problem.nameInvalid',
  'target-exists': 'welcome.copy.problem.targetExists',
  'location-missing': 'welcome.copy.problem.locationMissing',
  'location-unwritable': 'welcome.copy.problem.locationUnwritable',
  'inside-original': 'welcome.copy.problem.insideOriginal',
} as const satisfies Record<AstroCopyTargetProblem, string>;

export function problemMessage(problem: AstroCopyTargetProblem, translate: Translator): string {
  return translate(PROBLEM_KEYS[problem]);
}

/** The toast for a copy that was not made. */
export function failureMessage(failure: AstroCopyFailure, translate: Translator, format: Pick<Formatters, 'formatBytes' | 'formatNumber'>): string {
  switch (failure.code) {
    case 'not-plain-website':
      return translate('welcome.copy.failure.notWebsite');
    case 'too-many-files':
      return translate('welcome.copy.failure.tooManyFiles', { limit: format.formatNumber(failure.limit) });
    case 'too-many-bytes':
      return translate('welcome.copy.failure.tooManyBytes', { size: format.formatBytes(failure.limit) });
    case 'file-too-large':
      return translate('welcome.copy.failure.fileTooLarge', { file: failure.file, size: format.formatBytes(failure.limit) });
    case 'package-manager-missing':
      return translate('welcome.copy.failure.packageManager', { manager: failure.manager });
    case 'copy-failed':
      return translate('welcome.copy.failure.copy', { detail: failure.detail });
    case 'name-empty':
    case 'name-invalid':
    case 'target-exists':
    case 'location-missing':
    case 'location-unwritable':
    case 'inside-original':
      return problemMessage(failure.code, translate);
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
