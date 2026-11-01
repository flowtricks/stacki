// The rich text editor's toolbar: the block the caret is in, the marks, lists,
// links and rules, and undo. Each control shows whether it applies where the
// caret is, and its tooltip names its keyboard shortcut. Buttons never take
// focus from the text, so the selection they act on stays where it was.
import type { ReactNode } from 'react';
import Dropdown from './Dropdown';
import type { FormatState, Mark, RichTextAction } from './richTextCommands';
import {
  BoldIcon,
  BulletListIcon,
  ClearFormatIcon,
  InlineCodeIcon,
  ItalicIcon,
  LinkIcon,
  NumberListIcon,
  QuoteIcon,
  RedoIcon,
  RuleIcon,
  StrikeIcon,
  UnderlineIcon,
  UndoIcon,
} from './richTextIcons';
import type { Block } from './richTextModel';

interface Props {
  readonly format: FormatState;
  readonly source: boolean;
  /** Markup the editor cannot show locks the visual controls; HTML still edits it. */
  readonly locked: boolean;
  readonly onAction: (action: RichTextAction) => void;
  readonly onToggleSource: () => void;
  readonly onFormat: () => void;
}

/** The platform's modifier as tooltips write it. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const BLOCK_OPTIONS: readonly {
  readonly value: Block;
  readonly label: string;
  readonly hint: string;
}[] = [
  { value: 'p', label: 'Paragraph', hint: `${MOD}⌥0` },
  { value: 'h1', label: 'Heading 1', hint: '#' },
  { value: 'h2', label: 'Heading 2', hint: '##' },
  { value: 'h3', label: 'Heading 3', hint: '###' },
  { value: 'h4', label: 'Heading 4', hint: '####' },
  { value: 'h5', label: 'Heading 5', hint: '#####' },
  { value: 'h6', label: 'Heading 6', hint: '######' },
  { value: 'blockquote', label: 'Quote', hint: '>' },
  { value: 'pre', label: 'Code block', hint: '```' },
];

const MARK_BUTTONS: readonly {
  readonly mark: Mark;
  readonly label: string;
  readonly keys: string;
  readonly icon: ReactNode;
}[] = [
  { mark: 'bold', label: 'Bold', keys: `${MOD}B`, icon: <BoldIcon size={14} /> },
  { mark: 'italic', label: 'Italic', keys: `${MOD}I`, icon: <ItalicIcon size={14} /> },
  { mark: 'underline', label: 'Underline', keys: `${MOD}U`, icon: <UnderlineIcon size={14} /> },
  { mark: 'strike', label: 'Strikethrough', keys: `${MOD}⇧X`, icon: <StrikeIcon size={14} /> },
  { mark: 'code', label: 'Inline code', keys: `${MOD}E`, icon: <InlineCodeIcon size={14} /> },
  { mark: 'superscript', label: 'Superscript', keys: `${MOD}.`, icon: <ScriptIcon at="sup" /> },
  { mark: 'subscript', label: 'Subscript', keys: `${MOD},`, icon: <ScriptIcon at="sub" /> },
];

// The letter x with a small figure raised (x²) or lowered (x₂).
function ScriptIcon(props: { readonly at: 'sup' | 'sub' }) {
  return (
    <span className="html-script-icon" aria-hidden="true">
      x<span className={props.at === 'sup' ? 'is-raised' : 'is-lowered'}>2</span>
    </span>
  );
}

export function HtmlToolbar(props: Props) {
  const { format, onAction } = props;
  const visual = !props.source;
  return (
    <div className="html-toolbar" role="toolbar" aria-label="Text formatting">
      {visual && (
        <fieldset className="html-toolbar-controls" disabled={props.locked}>
          <Dropdown
            className="html-block-style"
            ariaLabel="Text style"
            value={format.block}
            // Choosing is a click: hovering a style must not restyle the text.
            livePreview={false}
            options={BLOCK_OPTIONS}
            onChange={(block) => onAction({ kind: 'block', block })}
          />
          <span className="html-toolbar-group">
            {MARK_BUTTONS.map((button) => (
              <ToolButton
                key={button.mark}
                label={button.label}
                keys={button.keys}
                pressed={format.marks.has(button.mark)}
                onPress={() => onAction({ kind: 'mark', mark: button.mark })}
              >
                {button.icon}
              </ToolButton>
            ))}
          </span>
          <InsertButtons format={format} onAction={onAction} />
        </fieldset>
      )}
      {props.source && (
        <button type="button" className="html-source-toggle html-format" title="Lay the HTML out to read" onClick={props.onFormat}>
          Format
        </button>
      )}
      <button
        type="button"
        className="html-source-toggle"
        aria-pressed={props.source}
        title={props.source ? 'Back to the visual editor' : 'Edit the HTML'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggleSource}
      >
        {props.source ? 'Visual' : 'HTML'}
      </button>
    </div>
  );
}

// Links, lists, quote, rule, clearing, and history.
function InsertButtons(props: Pick<Props, 'format' | 'onAction'>) {
  const { format, onAction } = props;
  const quote = format.block === 'blockquote';
  return (
    <>
      <span className="html-toolbar-group">
        <ToolButton label={format.link ? 'Edit link' : 'Link'} keys={`${MOD}K`} pressed={format.link !== undefined} onPress={() => onAction({ kind: 'link' })}>
          <LinkIcon size={14} />
        </ToolButton>
      </span>
      <span className="html-toolbar-group">
        <ToolButton label="Bulleted list" keys={`${MOD}⇧8`} pressed={format.list === 'ul'} onPress={() => onAction({ kind: 'list', list: 'ul' })}>
          <BulletListIcon size={14} />
        </ToolButton>
        <ToolButton label="Numbered list" keys={`${MOD}⇧7`} pressed={format.list === 'ol'} onPress={() => onAction({ kind: 'list', list: 'ol' })}>
          <NumberListIcon size={14} />
        </ToolButton>
        <ToolButton label="Quote" keys={`${MOD}⇧9`} pressed={quote} onPress={() => onAction({ kind: 'block', block: 'blockquote' })}>
          <QuoteIcon size={14} />
        </ToolButton>
        <ToolButton label="Divider" keys="---" onPress={() => onAction({ kind: 'rule' })}>
          <RuleIcon size={14} />
        </ToolButton>
      </span>
      <HistoryButtons onAction={onAction} />
    </>
  );
}

function HistoryButtons(props: Pick<Props, 'onAction'>) {
  const { onAction } = props;
  return (
    <span className="html-toolbar-group">
      <ToolButton label="Clear formatting" keys={`${MOD}\\`} onPress={() => onAction({ kind: 'clear' })}>
        <ClearFormatIcon size={14} />
      </ToolButton>
      <ToolButton label="Undo" keys={`${MOD}Z`} onPress={() => onAction({ kind: 'history', step: 'undo' })}>
        <UndoIcon size={14} />
      </ToolButton>
      <ToolButton label="Redo" keys={`${MOD}⇧Z`} onPress={() => onAction({ kind: 'history', step: 'redo' })}>
        <RedoIcon size={14} />
      </ToolButton>
    </span>
  );
}

function ToolButton(props: {
  readonly label: string;
  readonly keys: string;
  readonly pressed?: boolean;
  readonly children: ReactNode;
  readonly onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="html-tool"
      title={`${props.label}  ${props.keys}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      // The text keeps focus, and with it the selection this acts on.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}
