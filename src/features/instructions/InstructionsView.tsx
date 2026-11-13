// The open instructions file, over the canvas, laid out as the CMS lays out an
// entry: its header (title, muted path, the Source toggle and status in the
// actions), then a column of CMS fields — one per frontmatter key, then the body
// in the CMS's rich text field. The form itself comes from the app layer
// (`Form`), because the CMS field components belong to the CMS feature and a
// feature does not reach into another (eslint `stacki/source-layers`).
//
// Fidelity is the editor's own (markdownBlocks.ts, markdownWrite.ts): every block
// the person did not touch is written back byte for byte, so opening a file and
// closing it never writes, and an edit rewrites only what it changed. The
// frontmatter is spliced line by line (frontmatterFields.ts).
//
// Saves are debounced and witnessed by the text they were edited from
// (documentSession.ts). An outside change reloads the editor when nothing is
// unsaved; otherwise the person picks theirs, mine, or both merged. Undo is the
// editors' own, as for every field in the app (appShortcuts.ts hands ⌘Z back).
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import CodeEditor from '../../ui/CodeEditor';
import { CodeBlock } from '../../ui/CodeBlock';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import { CloseIcon } from '../../ui/Icons';
import { editableHTML } from '../../ui/htmlFieldModel';
import { markdownHTML, parseMarkdown, TASK_CLASS, TASK_DONE_CLASS } from '../../ui/markdownBlocks';
import { codeHighlightRules, paintCodeBlocks } from './codeBlockHighlights';
import { changedOnDisk, edited, isDirty, openSession, resolved, saved, shouldSave, type ConflictChoice, type DocumentSession } from './documentSession';
import { frontmatterView } from './frontmatterFields';
import { onInstructionsChanged, readInstruction, writeInstruction } from './instructionsBridge';
import './instructions.css';

/** How long typing rests before it is saved. */
export const SAVE_DELAY_MS = 600;

type ViewMode = 'rich' | 'source';
type LoadState = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready' };
type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'error'; readonly message: string };

/** What the form is given: the whole file, and a way to replace it. */
export interface InstructionFormProps {
  readonly source: string;
  readonly editable: boolean;
  readonly onChange: (source: string) => void;
}

export interface InstructionsViewProps {
  readonly projectPath: string;
  readonly file: string;
  readonly editable: boolean;
  readonly hidden?: boolean | undefined;
  readonly onClose: () => void;
}

export default function InstructionsView({
  projectPath,
  file,
  editable,
  hidden = false,
  Form,
  onClose,
}: InstructionsViewProps & { readonly Form: ComponentType<InstructionFormProps> }) {
  const translate = useTranslate();
  const document = useInstructionDocument(projectPath, file);
  const [mode, setMode] = useState<ViewMode>('rich');
  const { session } = document;
  return (
    <div className={`cms-view instructions-view ${hidden ? 'hidden' : ''}`} role="region" aria-label={translate('instructionsPanel.view.region', { file })}>
      <CodeHighlightStyles />
      <div className="cms-detail remote-cms-item">
        <div className="cms-detail-head remote-cms-item-head">
          <span className="cms-detail-title">{titleOf(file, session?.draft)}</span>
          <span className="instructions-view-path">{file}</span>
          <div className="remote-cms-item-meta">
            <SaveStatus session={session} save={document.save} editable={editable} />
            <SegmentedTabs
              label={translate('instructionsPanel.view.label')}
              value={mode}
              tabs={[
                { value: 'rich', label: translate('instructionsPanel.view.fields') },
                { value: 'source', label: translate('instructionsPanel.view.source') },
              ]}
              onPick={setMode}
            />
            <button type="button" className="ghost" aria-label={translate('instructionsPanel.view.closeFile')} title={translate('ui.close')} onClick={onClose}>
              <CloseIcon size={13} />
            </button>
          </div>
        </div>
        {session?.conflict !== undefined && <ConflictBar conflict={session.conflict} onChoose={document.resolve} />}
        <div className="cms-detail-body">
          {document.load.kind === 'loading' && <div className="props-empty">{translate('instructionsPanel.view.opening', { file })}</div>}
          {document.load.kind === 'error' && (
            <div className="props-empty" role="alert">
              {document.load.message}
            </div>
          )}
          {document.load.kind === 'ready' && session !== undefined && (
            <>
              {mode === 'source' ? (
                <div className="remote-cms-fields instructions-source">
                  {editable ? (
                    <CodeEditor language="markdown" value={session.draft} onChange={(text: string) => document.edit(text)} />
                  ) : (
                    <CodeBlock text={session.draft} language="markdown" label={file} />
                  )}
                </div>
              ) : (
                <RichDocument key={`${file}:${document.generation}`} source={session.draft} editable={editable} Form={Form} onChange={document.edit} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The entry's title: the frontmatter's `name` or `title`, else the file name. */
export function titleOf(file: string, source: string | undefined): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  assert(name.length > 0, 'A file has a name');
  if (source === undefined) {
    return name;
  }
  const view = frontmatterView(source);
  if (view.kind !== 'fields') {
    return name;
  }
  const named = view.fields.find((field) => field.key === 'name' || field.key === 'title');
  return named === undefined || named.value.trim() === '' ? name : named.value;
}

function SaveStatus(props: { readonly session: DocumentSession | undefined; readonly save: SaveState; readonly editable: boolean }) {
  const translate = useTranslate();
  if (!props.editable) {
    return <span className="remote-cms-times">{translate('instructionsPanel.view.readOnly')}</span>;
  }
  if (props.save.kind === 'error') {
    return (
      <span className="remote-cms-times instructions-status-error" role="alert">
        {props.save.message}
      </span>
    );
  }
  if (props.save.kind === 'saving') {
    return <span className="remote-cms-times">{translate('instructionsPanel.view.saving')}</span>;
  }
  return (
    <span className="remote-cms-times">
      {props.session !== undefined && isDirty(props.session) ? translate('instructionsPanel.view.edited') : translate('instructionsPanel.view.saved')}
    </span>
  );
}

function ConflictBar(props: { readonly conflict: NonNullable<DocumentSession['conflict']>; readonly onChoose: (choice: ConflictChoice) => void }) {
  const translate = useTranslate();
  return (
    <div className="instructions-conflict" role="alert">
      <span>{translate('instructionsPanel.conflict.message')}</span>
      <div className="instructions-conflict-actions">
        <button
          type="button"
          className="primary"
          disabled={props.conflict.merged === undefined}
          title={props.conflict.merged === undefined ? translate('instructionsPanel.conflict.blocked') : translate('instructionsPanel.conflict.mergeTip')}
          onClick={() => props.onChoose('merge')}
        >
          {translate('instructionsPanel.conflict.merge')}
        </button>
        <button type="button" onClick={() => props.onChoose('theirs')}>
          {translate('instructionsPanel.conflict.theirs')}
        </button>
        <button type="button" onClick={() => props.onChoose('mine')}>
          {translate('instructionsPanel.conflict.mine')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form: CMS fields for the frontmatter and the body (from the app layer)
// ---------------------------------------------------------------------------

function RichDocument(props: InstructionFormProps & { readonly Form: ComponentType<InstructionFormProps> }) {
  const host = useRef<HTMLDivElement>(null);
  useCodeColours(host);
  const { Form } = props;
  return (
    <div
      className="instructions-rich"
      ref={host}
      onMouseDown={(event) => {
        if (props.editable) {
          clickTask(event);
        }
      }}
    >
      <Form source={props.source} editable={props.editable} onChange={props.onChange} />
    </div>
  );
}

/** A body that cannot be edited, drawn as the rich text editor draws it. */
export function ReadOnlyBody(props: { readonly body: string }) {
  const html = useMemo(() => editableHTML(markdownHTML(parseMarkdown(props.body, { extensions: 'gfm' })), window.document).html, [props.body]);
  // The HTML is the editor's own projection: tags and attributes outside its allow-list are already removed.
  return (
    <div className="html-field">
      <div className="html-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** A click on a task item's box (left of its text) ticks it, as an edit the editor emits. */
export function clickTask(event: Pick<MouseEvent<HTMLElement>, 'target' | 'clientX' | 'preventDefault'>): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.localName !== 'li' || !target.classList.contains(TASK_CLASS)) {
    return;
  }
  const box = target.getBoundingClientRect();
  // The box is drawn in the item's left padding (instructions.css); a click on the text places the caret.
  if (event.clientX - box.left > TASK_BOX_PX) {
    return;
  }
  event.preventDefault();
  target.classList.toggle(TASK_DONE_CLASS);
  const editor = target.closest('[contenteditable="true"]');
  assert(editor !== null, 'A ticked task is inside the editor');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The width of a task's box and its gap, in CSS pixels (instructions.css `li.task`). */
const TASK_BOX_PX = 22;

// Code blocks are repainted after every change to the editor's text, a frame later.
function useCodeColours(host: RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return undefined;
    }
    let clear = paintCodeBlocks(element, window.document);
    let frame: number | undefined;
    const observer = new MutationObserver(() => {
      if (frame !== undefined) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = undefined;
        clear();
        clear = paintCodeBlocks(element, window.document);
      });
    });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      clear();
    };
  }, [host]);
}

/** The `::highlight()` rules the code colours use, once per document. */
export function CodeHighlightStyles() {
  return <style>{codeHighlightRules()}</style>;
}

// ---------------------------------------------------------------------------
// Loading, saving and outside changes
// ---------------------------------------------------------------------------

function useInstructionDocument(projectPath: string, file: string) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [session, setSession] = useState<DocumentSession>();
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  // Bumped when the text is replaced from outside, so the rich editor opens on it fresh.
  const [generation, setGeneration] = useState(0);
  const latest = useRef<DocumentSession>();
  latest.current = session;
  const inFlight = useRef(false);

  const replace = useCallback((next: DocumentSession, options: { readonly reopen: boolean }) => {
    setSession(next);
    latest.current = next;
    if (options.reopen) {
      setGeneration((count) => count + 1);
    }
  }, []);

  const reread = useCallback(async () => {
    const read = await readInstruction(projectPath, file);
    const current = latest.current;
    if (!read.ok || current === undefined || current.file !== file) {
      return;
    }
    const next = changedOnDisk(current, read.value.source);
    replace(next, { reopen: next.draft !== current.draft });
  }, [projectPath, file, replace]);

  const flush = useCallback(async () => {
    const current = latest.current;
    if (current === undefined || inFlight.current || !shouldSave(current)) {
      return;
    }
    inFlight.current = true;
    setSave({ kind: 'saving' });
    const draft = current.draft;
    try {
      const written = await writeInstruction(projectPath, { file, source: draft, base: current.base });
      const now = latest.current;
      if (written.ok && now !== undefined) {
        replace(saved(now, draft, written.value.source), { reopen: false });
        setSave({ kind: 'idle' });
      } else if (!written.ok && written.error.code === 'conflict') {
        setSave({ kind: 'idle' });
        await reread();
      } else if (!written.ok) {
        setSave({ kind: 'error', message: written.error.message });
      }
    } catch (failure: unknown) {
      setSave({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      inFlight.current = false;
    }
  }, [projectPath, file, replace, reread]);

  // The file is read once per open; a new file is a new session.
  useEffect(() => {
    let active = true;
    setLoad({ kind: 'loading' });
    setSession(undefined);
    void readInstruction(projectPath, file).then(
      (read) => {
        if (!active) {
          return;
        }
        if (read.ok) {
          replace(openSession(file, read.value.source), { reopen: true });
          setLoad({ kind: 'ready' });
        } else {
          setLoad({ kind: 'error', message: read.error.message });
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoad({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [projectPath, file, replace]);

  // Typing rests, then saves; closing the file or the window saves what is pending.
  useEffect(() => {
    if (session === undefined || !shouldSave(session)) {
      return undefined;
    }
    const timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, flush]);
  useEffect(() => () => void flush(), [flush]);

  useEffect(
    () =>
      onInstructionsChanged((files) => {
        if (files.length === 0 || files.includes(file)) {
          void reread();
        }
      }),
    [file, reread],
  );

  const edit = useCallback(
    (draft: string) => {
      const current = latest.current;
      if (current !== undefined && draft !== current.draft) {
        replace(edited(current, draft), { reopen: false });
      }
    },
    [replace],
  );
  const resolve = useCallback(
    (choice: ConflictChoice) => {
      const current = latest.current;
      if (current !== undefined) {
        replace(resolved(current, choice), { reopen: true });
      }
    },
    [replace],
  );
  return { load, session, save, generation, edit, resolve };
}
