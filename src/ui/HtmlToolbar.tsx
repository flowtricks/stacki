// The rich text editor's toolbar: the block the caret is in, the marks, lists,
// links and rules, and undo. Each control shows whether it applies where the
// caret is, and its tooltip names its keyboard shortcut. Buttons never take
// focus from the text, so the selection they act on stays where it was.
import type { ReactNode } from 'react';
import type { MessageKey } from '../lib/i18n/localeContext';
import { useTranslate } from '../lib/i18n/useTranslate';
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
  /** What the source view edits: `HTML`, or a Markdown body's `Markdown`. */
  readonly sourceLabel: string;
  /** Whether the source view has a Format button (HTML lays itself out to read). */
  readonly formattable: boolean;
  readonly onAction: (action: RichTextAction) => void;
  readonly onToggleSource: () => void;
  readonly onFormat: () => void;
}

/** The platform's modifier as tooltips write it. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

// Labels are keys, translated where the toolbar draws them: a module-level constant cannot call a hook.
const BLOCK_CHOICES: readonly {
  readonly value: Block;
  readonly label: MessageKey;
  readonly level?: number;
  readonly hint: string;
}[] = [
  { value: 'p', label: 'ui.htmlToolbar.paragraph', hint: `${MOD}⌥0` },
  { value: 'h1', label: 'ui.htmlToolbar.heading', level: 1, hint: '#' },
  { value: 'h2', label: 'ui.htmlToolbar.heading', level: 2, hint: '##' },
  { value: 'h3', label: 'ui.htmlToolbar.heading', level: 3, hint: '###' },
  { value: 'h4', label: 'ui.htmlToolbar.heading', level: 4, hint: '####' },
  { value: 'h5', label: 'ui.htmlToolbar.heading', level: 5, hint: '#####' },
  { value: 'h6', label: 'ui.htmlToolbar.heading', level: 6, hint: '######' },
  { value: 'blockquote', label: 'ui.htmlToolbar.quote', hint: '>' },
  { value: 'pre', label: 'ui.htmlToolbar.codeBlock', hint: '```' },
];

const MARK_BUTTONS: readonly {
  readonly mark: Mark;
  readonly label: MessageKey;
  readonly keys: string;
  readonly icon: ReactNode;
}[] = [
  { mark: 'bold', label: 'ui.htmlToolbar.bold', keys: `${MOD}B`, icon: <BoldIcon size={14} /> },
  { mark: 'italic', label: 'ui.htmlToolbar.italic', keys: `${MOD}I`, icon: <ItalicIcon size={14} /> },
  { mark: 'underline', label: 'ui.htmlToolbar.underline', keys: `${MOD}U`, icon: <UnderlineIcon size={14} /> },
  { mark: 'strike', label: 'ui.htmlToolbar.strikethrough', keys: `${MOD}⇧X`, icon: <StrikeIcon size={14} /> },
  { mark: 'code', label: 'ui.htmlToolbar.inlineCode', keys: `${MOD}E`, icon: <InlineCodeIcon size={14} /> },
  { mark: 'superscript', label: 'ui.htmlToolbar.superscript', keys: `${MOD}.`, icon: <ScriptIcon at="sup" /> },
  { mark: 'subscript', label: 'ui.htmlToolbar.subscript', keys: `${MOD},`, icon: <ScriptIcon at="sub" /> },
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
  const translate = useTranslate();
  const blockOptions = BLOCK_CHOICES.map((choice) => ({
    value: choice.value,
    label: translate(choice.label, { level: choice.level ?? 0 }),
    hint: choice.hint,
  }));
  return (
    <div className="html-toolbar" role="toolbar" aria-label={translate('ui.htmlToolbar.ariaLabel')}>
      {visual && (
        <fieldset className="html-toolbar-controls" disabled={props.locked}>
          <Dropdown
            className="html-block-style"
            ariaLabel={translate('ui.htmlToolbar.textStyle')}
            value={format.block}
            // Choosing is a click: hovering a style must not restyle the text.
            livePreview={false}
            options={blockOptions}
            onChange={(block) => onAction({ kind: 'block', block })}
          />
          <span className="html-toolbar-group">
            {MARK_BUTTONS.map((button) => (
              <ToolButton
                key={button.mark}
                label={translate(button.label)}
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
      {props.source && props.formattable && (
        <button type="button" className="html-source-toggle html-format" title={translate('ui.htmlToolbar.formatTitle')} onClick={props.onFormat}>
          {translate('ui.htmlToolbar.format')}
        </button>
      )}
      <button
        type="button"
        className="html-source-toggle"
        aria-pressed={props.source}
        title={props.source ? translate('ui.htmlToolbar.backToVisual') : translate('ui.htmlToolbar.editSource', { source: props.sourceLabel })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggleSource}
      >
        {props.source ? translate('ui.htmlToolbar.visual') : props.sourceLabel}
      </button>
    </div>
  );
}

// Links, lists, quote, rule, clearing, and history.
function InsertButtons(props: Pick<Props, 'format' | 'onAction'>) {
  const { format, onAction } = props;
  const translate = useTranslate();
  const quote = format.block === 'blockquote';
  return (
    <>
      <span className="html-toolbar-group">
        <ToolButton
          label={format.link ? translate('ui.htmlLink.edit') : translate('ui.htmlToolbar.link')}
          keys={`${MOD}K`}
          pressed={format.link !== undefined}
          onPress={() => onAction({ kind: 'link' })}
        >
          <LinkIcon size={14} />
        </ToolButton>
      </span>
      <span className="html-toolbar-group">
        <ToolButton
          label={translate('ui.htmlToolbar.bulletedList')}
          keys={`${MOD}⇧8`}
          pressed={format.list === 'ul'}
          onPress={() => onAction({ kind: 'list', list: 'ul' })}
        >
          <BulletListIcon size={14} />
        </ToolButton>
        <ToolButton
          label={translate('ui.htmlToolbar.numberedList')}
          keys={`${MOD}⇧7`}
          pressed={format.list === 'ol'}
          onPress={() => onAction({ kind: 'list', list: 'ol' })}
        >
          <NumberListIcon size={14} />
        </ToolButton>
        <ToolButton
          label={translate('ui.htmlToolbar.quote')}
          keys={`${MOD}⇧9`}
          pressed={quote}
          onPress={() => onAction({ kind: 'block', block: 'blockquote' })}
        >
          <QuoteIcon size={14} />
        </ToolButton>
        <ToolButton label={translate('ui.htmlToolbar.divider')} keys="---" onPress={() => onAction({ kind: 'rule' })}>
          <RuleIcon size={14} />
        </ToolButton>
      </span>
      <HistoryButtons onAction={onAction} />
    </>
  );
}

function HistoryButtons(props: Pick<Props, 'onAction'>) {
  const { onAction } = props;
  const translate = useTranslate();
  return (
    <span className="html-toolbar-group">
      <ToolButton label={translate('ui.htmlToolbar.clearFormatting')} keys={`${MOD}\\`} onPress={() => onAction({ kind: 'clear' })}>
        <ClearFormatIcon size={14} />
      </ToolButton>
      <ToolButton label={translate('ui.htmlToolbar.undo')} keys={`${MOD}Z`} onPress={() => onAction({ kind: 'history', step: 'undo' })}>
        <UndoIcon size={14} />
      </ToolButton>
      <ToolButton label={translate('ui.htmlToolbar.redo')} keys={`${MOD}⇧Z`} onPress={() => onAction({ kind: 'history', step: 'redo' })}>
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
