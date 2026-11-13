// Stacki's rich text editor: a contentEditable kept to the HTML a site's
// content uses. The toolbar shows what the caret is in; Markdown typed at the
// start of a line or around a word becomes the formatting it stands for; a
// paste keeps its headings, lists and links but none of its styles; a link
// under the caret shows a bubble to open, change or remove it. Opening a field
// never rewrites its HTML: only an edit writes, and markup the editor cannot
// show locks the visual editor rather than being dropped (htmlFieldModel.ts).
import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlLinkEditor, type LinkBubble, type LinkBubblePlace } from './HtmlLinkEditor';
import { HtmlToolbar, MOD } from './HtmlToolbar';
import { containsHTML, editableHTML } from './htmlFieldModel';
import {
  applyBlockShortcut,
  applyInlineShortcut,
  applyLink,
  EMPTY_FORMAT,
  inCode,
  inParagraph,
  lineBeforeCaret,
  performAction,
  rangeIn,
  readFormat,
  removeLink,
  shortcutAction,
  type FormatState,
  type RichTextAction,
} from './richTextCommands';
import { blockShortcut, cleanPastedHTML, inlineShortcut, linkAddress, textCounts } from './richTextModel';
import './contentInputs.css';
import './richText.css';
import { useTranslate } from '../lib/i18n/useTranslate';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  /** The source view in place of the HTML one: a Markdown body shows its Markdown. */
  readonly sourceView?: SourceView | undefined;
  readonly onChange: (value: string) => void;
}

export interface SourceView {
  /** The toggle's name for it: `Markdown`. */
  readonly label: string;
  readonly render: () => ReactNode;
}

// The live editor and what it remembers between events.
interface Editor {
  readonly host: MutableRefObject<HTMLDivElement | undefined>;
  /** The last selection inside the text, put back before a toolbar action. */
  readonly saved: MutableRefObject<Range | undefined>;
  /** Set by ⇧⌘V, so the paste that follows comes in as plain text. */
  readonly plainPaste: MutableRefObject<boolean>;
  readonly emit: () => void;
  readonly restore: () => HTMLDivElement | undefined;
}

export default function HtmlField({ value, label, sourceView, onChange }: Props) {
  const translate = useTranslate();
  const fieldLabel = label ?? translate('ui.htmlField.label');
  const [source, setSource] = useState(false);
  const [formatCount, setFormatCount] = useState(0);
  const projection = editableHTML(value, document);
  const state = useHtmlEditor({ value, projection, onChange });
  const { editor, bubble, setBubble } = state;
  return (
    <div className="html-field">
      <HtmlToolbar
        format={state.format}
        source={source}
        locked={projection.restricted}
        sourceLabel={sourceView?.label ?? 'HTML'}
        formattable={sourceView === undefined}
        onAction={state.run}
        onFormat={() => setFormatCount(formatCount + 1)}
        onToggleSource={() => {
          state.forget();
          setBubble(undefined);
          setFormatCount(0);
          setSource(!source);
        }}
      />
      <HtmlBody {...{ value, label: fieldLabel, source, sourceView, projection, editor, formatCount }} onAction={state.run} onChange={onChange} />
      {bubble && !source && (
        <HtmlLinkEditor
          bubble={bubble}
          onEdit={() => setBubble({ ...bubble, kind: 'edit' })}
          onApply={(href) => linkEdit(editor, (element) => applyLink(element, href), state.closeBubble)}
          onRemove={() => linkEdit(editor, removeLink, state.closeBubble)}
          onClose={state.closeBubble}
        />
      )}
      {!source && <HtmlFooter words={state.counts.words} characters={state.counts.characters} />}
    </div>
  );
}

// The editor's state: the live text, what the caret is in, the link bubble, the
// counts, and the actions the toolbar and keyboard run.
function useHtmlEditor(options: { readonly value: string; readonly projection: ReturnType<typeof editableHTML>; readonly onChange: (value: string) => void }) {
  const { value, projection, onChange } = options;
  const host = useRef<HTMLDivElement>();
  const saved = useRef<Range>();
  const plainPaste = useRef(false);
  const emitted = useRef<string>();
  const [format, setFormat] = useState<FormatState>(EMPTY_FORMAT);
  const [bubble, setBubble] = useState<LinkBubble>();
  const [counts, setCounts] = useState(textCounts(''));
  const refresh = (): void => {
    if (host.current !== undefined) {
      markEmpty(host.current);
      setCounts(textCounts(host.current.innerText ?? host.current.textContent ?? ''));
    }
  };
  useEffect(() => {
    if (host.current && value !== emitted.current) {
      host.current.innerHTML = projection.html;
      emitted.current = value;
      refresh();
    }
  });
  const editor: Editor = {
    host,
    saved,
    plainPaste,
    emit: () => {
      if (host.current !== undefined) {
        // Always leave a paragraph when emptied so the HTML field keeps its editor.
        const html = editableHTML(host.current.innerHTML, document).html;
        emitted.current = containsHTML(html) ? html : `<p>${html}</p>`;
        refresh();
        onChange(emitted.current);
      }
    },
    restore: () => restoreSelection(host.current, saved.current),
  };
  useSelectionTracking(editor, (next) => {
    setFormat(next);
    setBubble((open) => bubbleFor(host.current, next, open));
  });
  const run = (action: RichTextAction): void => {
    const element = editor.restore();
    if (element === undefined || projection.restricted) {
      return;
    }
    if (action.kind === 'link') {
      setBubble(editBubble(element, readFormat(element)));
      return;
    }
    performAction(element, action);
    editor.emit();
    setFormat(readFormat(element));
  };
  const closeBubble = (): void => {
    setBubble(undefined);
    editor.restore();
  };
  const forget = (): void => {
    emitted.current = undefined;
  };
  return { editor, format, bubble, setBubble, counts, run, closeBubble, forget };
}

interface BodyProps extends Props {
  readonly source: boolean;
  readonly projection: ReturnType<typeof editableHTML>;
  readonly editor: Editor;
  readonly formatCount: number;
  readonly onAction: (action: RichTextAction) => void;
}

function HtmlBody(props: BodyProps) {
  const translate = useTranslate();
  const { editor } = props;
  if (props.source && props.sourceView !== undefined) {
    return <>{props.sourceView.render()}</>;
  }
  if (props.source) {
    return (
      <HtmlSourceEditor value={props.value} label={props.label ?? translate('ui.htmlField.label')} formatCount={props.formatCount} onChange={props.onChange} />
    );
  }
  return (
    <>
      {props.projection.restricted && <div className="html-notice">{translate('ui.htmlField.restricted')}</div>}
      <div
        ref={(element) => {
          editor.host.current = element ?? undefined;
        }}
        className="html-content"
        role="textbox"
        aria-label={props.label}
        aria-multiline="true"
        aria-readonly={props.projection.restricted}
        data-placeholder={translate('ui.htmlField.placeholder')}
        contentEditable={!props.projection.restricted}
        suppressContentEditableWarning
        onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')}
        onInput={(event) => {
          typedShortcut(editor, event.nativeEvent);
          editor.emit();
        }}
        onKeyDown={(event) => keyDown(editor, event, props.onAction)}
        onClick={(event) => followLink(event, { open: event.metaKey || event.ctrlKey })}
        onPaste={(event) => {
          event.preventDefault();
          paste(editor, event.clipboardData);
        }}
        onDrop={(event) => event.preventDefault()}
      />
    </>
  );
}

function HtmlFooter(props: { readonly words: number; readonly characters: number }) {
  const translate = useTranslate();
  return (
    <div className="html-footer" aria-hidden="true">
      <span className="html-footer-hint">{translate('ui.htmlField.hint', { shortcut: `${MOD}K` })}</span>
      <span className="html-footer-counts">
        {translate('ui.htmlField.words', { count: props.words })} · {translate('ui.htmlField.characters', { count: props.characters })}
      </span>
    </div>
  );
}

// Keeps the saved selection and the toolbar's state in step with the caret.
function useSelectionTracking(editor: Editor, onFormat: (format: FormatState) => void): void {
  const latest = useRef(onFormat);
  latest.current = onFormat;
  const { host, saved } = editor;
  useEffect(() => {
    const track = (): void => {
      const element = host.current;
      const range = element === undefined ? undefined : rangeIn(element);
      if (element !== undefined && range !== undefined) {
        saved.current = range.cloneRange();
        latest.current(readFormat(element));
      }
    };
    document.addEventListener('selectionchange', track);
    return () => document.removeEventListener('selectionchange', track);
  }, [host, saved]);
}

function keyDown(editor: Editor, event: KeyboardEvent<HTMLDivElement>, onAction: (action: RichTextAction) => void): void {
  const element = editor.host.current;
  if (element === undefined) {
    return;
  }
  const mod = MOD === '⌘' ? event.metaKey : event.ctrlKey;
  if (mod && event.shiftKey && event.code === 'KeyV') {
    const { plainPaste } = editor;
    plainPaste.current = true;
    return;
  }
  const action = shortcutAction({
    key: event.key,
    code: event.code,
    mod,
    shift: event.shiftKey,
    alt: event.altKey,
  });
  if (action !== undefined) {
    event.preventDefault();
    onAction(action);
    return;
  }
  const format = readFormat(element);
  if (event.key === 'Tab' && format.list !== undefined) {
    // In a list, Tab nests the item and ⇧Tab brings it back out.
    event.preventDefault();
    document.execCommand(event.shiftKey ? 'outdent' : 'indent');
    editor.emit();
    return;
  }
  if (event.key === 'Backspace' && format.block !== 'p' && lineBeforeCaret(element) === '') {
    // Backspace at the start of a heading, quote or code block makes it a paragraph again.
    event.preventDefault();
    performAction(element, { kind: 'block', block: format.block });
    editor.emit();
  }
}

// Markdown typed as text: a line's prefix and a space, or a closed `**run**`.
function typedShortcut(editor: Editor, event: Event): void {
  const element = editor.host.current;
  if (element === undefined || !(event instanceof InputEvent)) {
    return;
  }
  if (event.inputType !== 'insertText' || event.data === null || inCode(element)) {
    return;
  }
  if ((event.data === ' ' || event.data === '-') && inParagraph(element)) {
    const shortcut = blockShortcut(lineBeforeCaret(element) ?? '');
    if (shortcut !== undefined) {
      applyBlockShortcut(element, shortcut);
      return;
    }
  }
  if ('*_`~'.includes(event.data)) {
    const range = rangeIn(element);
    const node = range?.startContainer;
    if (range !== undefined && node instanceof Text) {
      const shortcut = inlineShortcut(node.data.slice(0, range.startOffset));
      if (shortcut !== undefined) {
        applyInlineShortcut(element, shortcut);
      }
    }
  }
}

// A paste: a link over selected text links it; HTML keeps its structure, cleaned;
// anything else, or a ⇧⌘V paste, comes in as plain text.
function paste(editor: Editor, data: DataTransfer): void {
  const element = editor.host.current;
  const { plainPaste } = editor;
  const plain = plainPaste.current;
  plainPaste.current = false;
  if (element === undefined) {
    return;
  }
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  const address = /^\S+$/.test(text.trim()) ? linkAddress(text) : undefined;
  const range = rangeIn(element);
  if (!plain && address !== undefined && range !== undefined && !range.collapsed) {
    applyLink(element, address);
  } else if (!plain && html !== '' && html.length <= BOUNDARY_LIMITS.textLengthMax) {
    document.execCommand('insertHTML', false, cleanPastedHTML(html, document));
  } else {
    document.execCommand('insertText', false, text.slice(0, BOUNDARY_LIMITS.textLengthMax));
  }
  editor.emit();
}

// A link in the text is not followed on a click, which places the caret in it;
// ⌘-click opens it, as in other editors.
function followLink(event: { readonly target: EventTarget; preventDefault(): void }, options: { readonly open: boolean }): void {
  const link = event.target instanceof Element ? event.target.closest('a') : undefined;
  if (link === null || link === undefined) {
    return;
  }
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (options.open && /^(?:https?:|mailto:|tel:)/i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

function linkEdit(editor: Editor, edit: (element: HTMLElement) => void, done: () => void): void {
  const element = editor.restore();
  if (element !== undefined) {
    edit(element);
    editor.emit();
  }
  done();
}

// The bubble the caret calls for: a link's address under it, kept while editing.
function bubbleFor(element: HTMLElement | undefined, format: FormatState, open: LinkBubble | undefined): LinkBubble | undefined {
  if (open?.kind === 'edit') {
    return open;
  }
  if (element === undefined || format.link === undefined) {
    return undefined;
  }
  const href = format.link.getAttribute('href') ?? '';
  return { kind: 'view', href, place: placeUnder(element, format.link.getBoundingClientRect()) };
}

function editBubble(element: HTMLElement, format: FormatState): LinkBubble {
  const href = format.link?.getAttribute('href') ?? '';
  const rect = (format.link ?? rangeIn(element))?.getBoundingClientRect();
  return { kind: 'edit', href, place: placeUnder(element, rect) };
}

// Under the text it is about, kept inside the field.
function placeUnder(element: HTMLElement, rect: DOMRect | undefined): LinkBubblePlace {
  const field = element.closest('.html-field') ?? element;
  const box = field.getBoundingClientRect();
  if (rect === undefined || rect.height === 0) {
    return { top: element.offsetTop + 32, left: 12 };
  }
  const left = Math.min(Math.max(rect.left - box.left, 8), Math.max(box.width - 320, 8));
  return { top: rect.bottom - box.top + 6, left };
}

function restoreSelection(element: HTMLDivElement | undefined, range: Range | undefined): HTMLDivElement | undefined {
  if (element === undefined) {
    return undefined;
  }
  element.focus();
  if (range !== undefined && element.contains(range.commonAncestorContainer)) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return element;
}

// An empty editor shows its placeholder; a rule or a list is content, not empty.
function markEmpty(element: HTMLElement): void {
  const empty = (element.textContent ?? '').trim() === '' && !element.querySelector('hr, img, li');
  element.dataset['empty'] = String(empty);
}
