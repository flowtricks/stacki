// Stacki's rich text editor: a contentEditable kept to the HTML a site's
// content uses. The toolbar shows what the caret is in; Markdown typed at the
// start of a line or around a word becomes the formatting it stands for; a
// paste keeps its headings, lists and links but none of its styles; a link
// under the caret shows a bubble to open, change or remove it. Opening a field
// never rewrites its HTML: only an edit writes, and markup the editor cannot
// show locks the visual editor rather than being dropped (htmlFieldModel.ts).
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { chooseAsset } from './assetPick';
import { assetValueFor } from './assetPath';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlLinkEditor, type LinkBubble, type LinkBubblePlace } from './HtmlLinkEditor';
import { HtmlToolbar, MOD } from './HtmlToolbar';
import { containsHTML, editableHTML } from './htmlFieldModel';
import { RICH_HISTORY_EVENT } from '../editor/canvasTextFocus';
import { pasteRichText } from '../../shared/page/richPaste';
import {
  deleteBesideRichMedia,
  keepTypingInBlocks,
  selectRichMedia,
  isSpareRichLine,
  leaveQuoteOnEnter,
  richElement,
  richHistoryOf,
  withoutTypingResidue,
  tidyRichContent,
  withoutTrailingEmptyBlocks,
} from '../../shared/page/richBlockDom';
import {
  applyBlockShortcut,
  applyInlineShortcut,
  applyLink,
  EMPTY_FORMAT,
  inCode,
  inParagraph,
  insertBlock,
  lineBeforeCaret,
  performAction,
  rangeIn,
  readFormat,
  removeLink,
  shortcutAction,
  type FormatState,
  type RichTextAction,
} from './richTextCommands';
import { blockShortcut, inlineShortcut, linkAddress, textCounts, type Block } from './richTextModel';
import Menu, { type MenuEntry } from './Menu';
import { PlusIcon } from './Icons';
import './contentInputs.css';
import './richText.css';
import { useTranslate } from '../lib/i18n/useTranslate';
import TipAnchor from './TipAnchor';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  /** The source view in place of the HTML one: a Markdown body shows its Markdown. */
  readonly sourceView?: SourceView | undefined;
  /**
   * Rich text a component's slot holds: a `+` beside an empty block chooses what the block is (a heading, a quote, a
   * list, an image, a video …), and video is content the editor keeps. Off for CMS fields, which keep their list.
   */
  readonly blocks?: 'insert' | undefined;
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

export default function HtmlField({ value, label, sourceView, blocks, onChange }: Props) {
  const translate = useTranslate();
  const fieldLabel = label ?? translate('ui.htmlField.label');
  const [source, setSource] = useState(false);
  const [formatCount, setFormatCount] = useState(0);
  const projection = editableHTML(value, document, { media: blocks === 'insert' });
  const state = useHtmlEditor({ value, projection, media: blocks === 'insert', onChange });
  const { editor, bubble, setBubble } = state;
  return (
    <div className={blocks === 'insert' ? 'html-field html-field-blocks' : 'html-field'}>
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
      <HtmlBody {...{ value, label: fieldLabel, source, sourceView, projection, editor, formatCount, blocks }} onAction={state.run} onChange={onChange} />
      {bubble && !source && (
        <HtmlLinkEditor
          bubble={bubble}
          onEdit={() => setBubble({ ...bubble, kind: 'edit' })}
          onApply={(href) => linkEdit(editor, (element) => applyLink(element, href), state.closeBubble)}
          onRemove={() => linkEdit(editor, removeLink, state.closeBubble)}
          onClose={state.closeBubble}
        />
      )}
      {blocks === 'insert' && !source && !projection.restricted && <BlockInsert editor={editor} place={state.plus} onAction={state.run} />}
      {!source && <HtmlFooter words={state.counts.words} characters={state.counts.characters} />}
    </div>
  );
}

// The editor's state: the live text, what the caret is in, the link bubble, the
// counts, and the actions the toolbar and keyboard run.
function useHtmlEditor(options: {
  readonly value: string;
  readonly projection: ReturnType<typeof editableHTML>;
  readonly media: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { value, projection, media, onChange } = options;
  const [plus, setPlus] = useState<BlockPlace>();
  const host = useRef<HTMLDivElement>();
  const saved = useRef<Range>();
  const plainPaste = useRef(false);
  const emitted = useRef<string>();
  // The content as it came from outside: what typing leaves behind is told from the author's own by it.
  const opened = useRef(value);
  const [format, setFormat] = useState<FormatState>(EMPTY_FORMAT);
  const [bubble, setBubble] = useState<LinkBubble>();
  const [counts, setCounts] = useState(textCounts(''));
  const refresh = (): void => {
    if (host.current !== undefined) {
      markEmpty(host.current);
      setCounts(textCounts(host.current.innerText ?? host.current.textContent ?? ''));
    }
  };
  // The value the field was last drawn from. Only a value that changed can be news from outside: a render in between
  // an edit and the parent taking it still holds the one before, and must not put the old content back.
  const seen = useRef<string>();
  useEffect(() => {
    const changed = value !== seen.current;
    seen.current = value;
    if (host.current && changed && value !== emitted.current) {
      host.current.innerHTML = projection.html;
      emitted.current = value;
      opened.current = value;
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
        const html = editableHTML(writtenHTML(host.current, { rich: media, opened: opened.current }), document, { media }).html;
        emitted.current = containsHTML(html) ? html : `<p>${html}</p>`;
        refresh();
        onChange(emitted.current);
      }
    },
    restore: () => restoreSelection(host.current, saved.current),
  };
  // The menu's ⌘Z and ⇧⌘Z for a block placed whole; a step not taken here is the browser's.
  const emitRef = useRef(editor.emit);
  emitRef.current = editor.emit;
  useEffect(() => {
    const element = host.current;
    if (element === undefined) {
      return undefined;
    }
    const onStep = (event: Event) => {
      const step: unknown = event instanceof CustomEvent ? event.detail : undefined;
      if ((step === 'undo' || step === 'redo') && richHistoryOf(element)[step]()) {
        event.preventDefault();
        emitRef.current();
      }
    };
    element.addEventListener(RICH_HISTORY_EVENT, onStep);
    return () => element.removeEventListener(RICH_HISTORY_EVENT, onStep);
  });
  useSelectionTracking(editor, (next) => {
    setFormat(next);
    setBubble((open) => bubbleFor(host.current, next, open));
    setPlus(host.current === undefined ? undefined : emptyBlockPlace(host.current));
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
    seen.current = undefined;
  };
  return { editor, format, bubble, setBubble, counts, run, closeBubble, forget, plus };
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
        onKeyDown={(event) => {
          if (props.blocks === 'insert' && (event.key === 'Backspace' || event.key === 'Delete')) {
            if (deleteBesideRichMedia(event.currentTarget, richHistoryOf(event.currentTarget), event.key)) {
              event.preventDefault();
              editor.emit();
              return;
            }
          }
          if (props.blocks === 'insert' && event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            if (leaveQuoteOnEnter(event.currentTarget, richHistoryOf(event.currentTarget))) {
              event.preventDefault();
              editor.emit();
              return;
            }
          }
          // Rich text a component holds: Enter starts a new block (the browser's own), ⌘/Ctrl Enter breaks the line
          // inside the block, as typing on the canvas does.
          if (props.blocks === 'insert' && event.key === 'Enter' && (MOD === '⌘' ? event.metaKey : event.ctrlKey)) {
            event.preventDefault();
            document.execCommand('insertLineBreak');
            editor.emit();
            return;
          }
          keyDown(editor, event, props.onAction);
        }}
        onClick={(event) => {
          if (props.blocks === 'insert' && event.target instanceof Element && event.target.matches('img, video, hr')) {
            selectRichMedia(event.target);
          }
          followLink(event, { open: event.metaKey || event.ctrlKey });
        }}
        onBeforeInput={(event) => {
          if (props.blocks === 'insert') {
            keepTypingInBlocks(event.currentTarget, richHistoryOf(event.currentTarget));
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          paste(editor, event.clipboardData, { media: props.blocks === 'insert' });
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

/** Where the `+` of an empty block sits, in the field's own coordinates. */
interface BlockPlace {
  readonly top: number;
  readonly height: number;
}

// The block the caret is in, when it holds nothing yet: the place to choose what it becomes. A block is a child of the
// editor, or a list item; a rule, an image or a video is content, not an empty block.
function emptyBlockPlace(host: HTMLElement): BlockPlace | undefined {
  const range = rangeIn(host);
  if (range === undefined || !range.collapsed) {
    return undefined;
  }
  // An editor with nothing in it yet: its first line is the empty block.
  if ((host.textContent ?? '').trim() === '' && host.querySelector('*:not(br)') === null) {
    const field = host.closest('.html-field') ?? host;
    const box = host.getBoundingClientRect();
    const style = getComputedStyle(host);
    const line = parseFloat(style.lineHeight) || 20;
    return { top: box.top - field.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0), height: line };
  }
  let node: Node | undefined = range.startContainer;
  for (let depth = 0; node !== undefined && node.parentNode !== host && depth < 64; depth++) {
    node = node.parentNode ?? undefined;
  }
  if (!(node instanceof HTMLElement) || node.parentNode !== host) {
    return undefined;
  }
  if ((node.textContent ?? '').trim() !== '' || node.querySelector('img, hr, video') !== null || ['HR', 'IMG', 'VIDEO'].includes(node.tagName)) {
    return undefined;
  }
  const field = host.closest('.html-field') ?? host;
  const box = node.getBoundingClientRect();
  return { top: box.top - field.getBoundingClientRect().top, height: box.height };
}

/** What the `+` menu chooses for an empty block; the dialog and the canvas each carry it out on their own text. */
export type BlockInsertChoice =
  | { readonly kind: 'block'; readonly block: Block }
  | { readonly kind: 'list'; readonly list: 'ul' | 'ol' }
  | { readonly kind: 'rule' }
  | { readonly kind: 'link' }
  | { readonly kind: 'media'; readonly media: 'image' | 'video' };

/** The `+` button's side, as `.html-block-plus` draws it (richText.css): what placing it is measured with. */
export const BLOCK_PLUS_PX = 24;

// The `+` and the menu it opens, in the order a writer reaches for them: the headings, then paragraph, quote, image,
// link and video, then the other common rich text blocks. Shared by the rich text dialog and the canvas.
export function BlockInsertButton(props: {
  readonly style?: CSSProperties;
  readonly onChoose: (choice: BlockInsertChoice) => void;
  /** The menu closed with nothing chosen. */
  readonly onDismiss?: () => void;
}) {
  const chose = useRef(false);
  const translate = useTranslate();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const item = (id: string, label: string, choice: BlockInsertChoice): MenuEntry => {
    const onSelect = () => {
      chose.current = true;
      props.onChoose(choice);
    };
    return { kind: 'item', id, label, onSelect };
  };
  const close = () => {
    setAnchor(undefined);
    // After the choice, which the menu may report in either order.
    queueMicrotask(() => {
      if (!chose.current) {
        props.onDismiss?.();
      }
      chose.current = false;
    });
  };
  const entries: readonly MenuEntry[] = [
    ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((tag, index) =>
      item(tag, translate('ui.htmlToolbar.heading', { level: index + 1 }), { kind: 'block', block: tag }),
    ),
    item('p', translate('ui.htmlToolbar.paragraph'), { kind: 'block', block: 'p' }),
    item('blockquote', translate('ui.htmlToolbar.quote'), { kind: 'block', block: 'blockquote' }),
    item('image', translate('ui.htmlField.image'), { kind: 'media', media: 'image' }),
    item('link', translate('ui.htmlToolbar.link'), { kind: 'link' }),
    item('video', translate('ui.htmlField.video'), { kind: 'media', media: 'video' }),
    { kind: 'divider', id: 'more' },
    item('ul', translate('ui.htmlToolbar.bulletedList'), { kind: 'list', list: 'ul' }),
    item('ol', translate('ui.htmlToolbar.numberedList'), { kind: 'list', list: 'ol' }),
    item('hr', translate('ui.htmlToolbar.divider'), { kind: 'rule' }),
    item('pre', translate('ui.htmlToolbar.codeBlock'), { kind: 'block', block: 'pre' }),
  ];
  return (
    <>
      {/* No tip over the open menu: it names the button, and the menu is already saying what it does. */}
      <TipAnchor text={anchor === undefined ? translate('ui.htmlField.insertBlock') : undefined}>
        <button
          type="button"
          className="html-block-plus"
          style={props.style}
          aria-label={translate('ui.htmlField.insertBlock')}
          aria-haspopup="menu"
          aria-expanded={anchor !== undefined}
          // The caret stays in the empty block: the menu's choice acts on it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => setAnchor(anchor === undefined ? event.currentTarget : undefined)}
        >
          <PlusIcon size={16} />
        </button>
      </TipAnchor>
      <Menu open={anchor !== undefined} anchor={anchor} entries={entries} label={translate('ui.htmlField.insertBlock')} onClose={close} />
    </>
  );
}

/**
 * An image or a video from the asset picker (the Assets panel over the page, or an app that answers picks), handed
 * over as the address the markup uses; a hosted file comes as its public URL.
 */
export function pickMedia(media: 'image' | 'video', insert: (address: string) => void): void {
  void chooseAsset(
    { mediaKind: media, current: '', presentation: 'overlay', onPick: (rel: string) => insert(assetValueFor(rel)), onPickURL: insert },
    { bypass: false, target: undefined },
  );
}

// The dialog's `+`: beside the empty block the caret is in. An image or a video comes from the asset picker, or from
// the address typed in the field that opens with it; a link asks for its address as the toolbar's link does.
function BlockInsert(props: { readonly editor: Editor; readonly place: BlockPlace | undefined; readonly onAction: (action: RichTextAction) => void }) {
  const [media, setMedia] = useState<{ readonly kind: 'image' | 'video'; readonly place: LinkBubblePlace }>();
  const { editor, place, onAction } = props;
  const insertMedia = (kind: 'image' | 'video', address: string) => {
    const element = editor.restore();
    setMedia(undefined);
    if (element !== undefined) {
      insertBlock(element, richElement(element.ownerDocument, kind === 'image' ? 'img' : 'video', address));
      editor.emit();
      // The asset picker takes focus with it as it closes: the field gets it back once it has gone, so typing goes on
      // and ⌘Z is the field's.
      setTimeout(() => editor.restore(), 0);
    }
  };
  const choose = (choice: BlockInsertChoice) => {
    switch (choice.kind) {
      case 'media':
        editor.restore();
        setMedia({ kind: choice.media, place: { top: (place?.top ?? 0) + (place?.height ?? 0) + 6, left: 12 } });
        pickMedia(choice.media, (address) => insertMedia(choice.media, address));
        return;
      case 'list': {
        // A list of its own, beside the line it replaces: the browser's command would nest it in that paragraph.
        const element = editor.restore();
        if (element !== undefined) {
          insertBlock(element, richElement(element.ownerDocument, choice.list));
          editor.emit();
        }
        return;
      }
      case 'block':
      case 'rule':
      case 'link':
        onAction(choice);
        return;
      default: {
        const exhaustive: never = choice;
        return exhaustive;
      }
    }
  };
  return (
    <>
      {place !== undefined && <BlockInsertButton style={{ top: place.top + Math.max(0, Math.floor((place.height - BLOCK_PLUS_PX) / 2)) }} onChoose={choose} />}
      {media && (
        <HtmlLinkEditor
          bubble={{ kind: 'edit', href: '', place: media.place }}
          onEdit={() => {}}
          onApply={(address) => insertMedia(media.kind, address)}
          onRemove={() => setMedia(undefined)}
          onClose={() => {
            setMedia(undefined);
            editor.restore();
          }}
        />
      )}
    </>
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
  // ⌘Z over a block placed whole, which the browser's own history does not know; every other undo is the browser's.
  if (mod && !event.altKey && event.key.toLowerCase() === 'z' && richHistoryOf(element)[event.shiftKey ? 'redo' : 'undo']()) {
    event.preventDefault();
    editor.emit();
    return;
  }
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

// A paste: a link over selected text links it; HTML keeps its structure, cleaned; anything else, or a ⇧⌘V paste,
// comes in as plain text. Blocks are placed beside the caret's block (richPaste.ts).
function paste(editor: Editor, data: DataTransfer, options: { readonly media: boolean }): void {
  const element = editor.host.current;
  const { plainPaste } = editor;
  const plain = plainPaste.current;
  plainPaste.current = false;
  if (element === undefined) {
    return;
  }
  const range = rangeIn(element);
  const text = data.getData('text/plain');
  // A bare domain over selected words links them too.
  const address = /^\S+$/.test(text.trim()) ? linkAddress(text) : undefined;
  if (!plain && address !== undefined && range !== undefined && !range.collapsed) {
    applyLink(element, address);
  } else {
    pasteRichText({ host: element, history: richHistoryOf(element), kind: 'rich', media: options.media }, { html: data.getData('text/html'), text, plain });
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

// What the field writes: valid HTML, and in rich text without the empty paragraph kept open at its end.
function writtenHTML(host: HTMLElement, options: { readonly rich: boolean; readonly opened: string }): string {
  const copy = host.ownerDocument.createElement('div');
  copy.innerHTML = host.innerHTML;
  Array.from(copy.children)
    .filter(isSpareRichLine)
    .forEach((line) => line.remove());
  copy.querySelectorAll('[data-avb-line]').forEach((line) => line.removeAttribute('data-avb-line'));
  tidyRichContent(copy);
  if (options.rich) {
    withoutTypingResidue(copy, options.opened);
  }
  return options.rich ? withoutTrailingEmptyBlocks(copy.innerHTML) : copy.innerHTML;
}

// An empty editor shows its placeholder; a rule or a list is content, not empty.
function markEmpty(element: HTMLElement): void {
  const empty = (element.textContent ?? '').trim() === '' && !element.querySelector('hr, img, li');
  element.dataset['empty'] = String(empty);
}
