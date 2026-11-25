// How a component's text is edited, in two places of the Properties panel:
//
// - While its defaults are being set, the last two rows of Settings switch Allow line breaks and Allow rich text
//   editing (the second only for a component that can take HTML children). Each switch writes .stacki/components.json
//   at once (useDefaultsCanvas.setEditing).
// - On an instance of a component with rich text on, the Content field becomes an Edit rich text button that opens the
//   rich text editor in a dialog, with a `{}` beside the label that shows the same content as code. Content the editor
//   cannot give back unchanged opens as code alone, and the toggle's tooltip says why (richTextContent.ts).
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { EditingSetting, EditingSettings } from '../../../shared/properties/componentDefaults';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { SwitchRow } from '../../ui/Switch';
import TipAnchor from '../../ui/TipAnchor';
import Popup from '../../ui/Popup';
import HtmlField from '../../ui/HtmlField';
import CodeEditor from '../../ui/CodeEditor';
import { BracesIcon } from '../../ui/Icons';
import type { InlineNode } from './richContentModel';
import { richTextNodes, richTextView, type RichTextCodeReason } from './richTextContent';

/** The defaults editor's hold on the selected component's editing settings. */
export interface ComponentEditingControl {
  readonly settings: EditingSettings;
  /** The component takes HTML children (componentDefaults.ts richTextAllowed): only then is rich text offered. */
  readonly richTextAllowed: boolean;
  readonly onChange: (setting: EditingSetting, value: 'on' | 'off') => void;
}

const SETTING_LABELS: Readonly<Record<EditingSetting, MessageKey>> = {
  lineBreaks: 'props.editing.lineBreaks',
  richText: 'props.editing.richText',
};
const SETTING_TIPS: Readonly<Record<EditingSetting, MessageKey>> = {
  lineBreaks: 'props.editing.lineBreaksTip',
  richText: 'props.editing.richTextTip',
};

export function ComponentEditingSwitches({ control }: { readonly control: ComponentEditingControl }) {
  const translate = useTranslate();
  const shown: readonly EditingSetting[] = control.richTextAllowed ? ['lineBreaks', 'richText'] : ['lineBreaks'];
  assert(shown.length > 0, 'Line breaks are offered for every component');
  return (
    <>
      {shown.map((setting) => (
        <div className="props-field props-editing-setting" key={setting}>
          <TipAnchor text={translate(SETTING_TIPS[setting])}>
            <SwitchRow
              label={translate(SETTING_LABELS[setting])}
              checked={control.settings[setting] === true}
              onToggle={() => control.onChange(setting, control.settings[setting] === true ? 'off' : 'on')}
            />
          </TipAnchor>
        </div>
      ))}
    </>
  );
}

const CODE_REASON_TIPS: Readonly<Record<RichTextCodeReason, MessageKey>> = {
  expression: 'props.richText.codeExpression',
  component: 'props.richText.codeComponent',
  markup: 'props.richText.codeMarkup',
  size: 'props.richText.codeSize',
};

export function RichTextContentField(props: {
  readonly label: string;
  /** The content as written between the instance's tags; undefined when there is none. */
  readonly source: string | undefined;
  readonly onSetNodes: (nodes: readonly InlineNode[]) => void;
  /** Writes code typed in the code view; absent where the host has no source writer, so the code is read only. */
  readonly onSetSource: ((source: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const decision = richTextView(props.source, document);
  const [chosen, setChosen] = useState<'rich' | 'code'>('rich');
  const [open, setOpen] = useState(false);
  const view = decision.view === 'code' ? 'code' : chosen;
  const tip =
    decision.view === 'code'
      ? translate(CODE_REASON_TIPS[decision.reason])
      : view === 'code'
        ? translate('props.richText.useEditor')
        : translate('props.richText.viewCode');
  return (
    <div className="props-field props-rich-text" key="content">
      <div className="props-rich-text-label">
        <span>{props.label}</span>
        <TipAnchor text={tip}>
          <button
            type="button"
            className={`prop-expr-toggle${view === 'code' ? ' on' : ''}`}
            aria-pressed={view === 'code'}
            aria-disabled={decision.view === 'code'}
            aria-label={translate('props.richText.asCode')}
            onClick={() => {
              if (decision.view === 'rich') {
                setChosen(view === 'code' ? 'rich' : 'code');
              }
            }}
          >
            <BracesIcon size={12} />
          </button>
        </TipAnchor>
      </div>
      {view === 'code' ? (
        <RichTextCode source={props.source ?? ''} onSetSource={props.onSetSource} />
      ) : (
        <button type="button" className="props-rich-text-edit" onClick={() => setOpen(true)}>
          {translate('props.richText.edit')}
        </button>
      )}
      {open && decision.view === 'rich' && (
        <RichTextDialog label={props.label} html={decision.html} onSetNodes={props.onSetNodes} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

// The editor in a dialog. It keeps the HTML it emitted: the page writes it back as the printer lays it out, which is the
// same content in other whitespace, and putting that into the editor would move the caret. Content that changes in
// any other way (a canvas edit, undo) is someone else's and replaces what the editor shows.
function RichTextDialog(props: {
  readonly label: string;
  readonly html: string;
  readonly onSetNodes: (nodes: readonly InlineNode[]) => void;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(props.html);
  const written = useRef(props.html);
  useEffect(() => {
    if (!sameRichContent(props.html, written.current, document)) {
      written.current = props.html;
      setDraft(props.html);
    }
  }, [props.html]);
  return (
    <Popup className="modal props-rich-text-dialog" label={translate('props.richText.title')} onClose={props.onClose} dismissible={true}>
      <div className="modal-header">{props.label}</div>
      <div className="modal-body">
        <HtmlField
          value={draft}
          label={props.label}
          blocks="insert"
          onChange={(html) => {
            written.current = html;
            setDraft(html);
            props.onSetNodes(richTextNodes(html, document));
          }}
        />
      </div>
    </Popup>
  );
}

// The code view: highlighted and editable, written when it loses focus, never mid-typing, so a half-written tag never
// reaches the page; content changed elsewhere shows as soon as nothing is being typed here.
function RichTextCode(props: { readonly source: string; readonly onSetSource: ((source: string) => void) | undefined }) {
  const [draft, setDraft] = useState(props.source);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) {
      setDraft(props.source);
    }
  }, [props.source]);
  const { onSetSource } = props;
  return (
    <div
      className="props-rich-text-code"
      onFocus={() => {
        typing.current = true;
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) {
          return;
        }
        typing.current = false;
        if (onSetSource !== undefined && draft !== props.source) {
          onSetSource(draft);
        }
      }}
    >
      <CodeEditor value={draft} language="astro" chrome="minimal" {...(onSetSource === undefined ? {} : { onChange: (text: string) => setDraft(text) })} />
    </div>
  );
}

/** Whether two HTML texts hold the same rich content, whatever whitespace lies between their blocks. */
export function sameRichContent(left: string, right: string, document: Document): boolean {
  return JSON.stringify(richShape(richTextNodes(left, document), 0)) === JSON.stringify(richShape(richTextNodes(right, document), 0));
}

// The content with whitespace runs folded and text that is only whitespace left out: what a reader sees.
function richShape(nodes: readonly InlineNode[], depth: number): readonly unknown[] {
  assert(depth <= LIMITS.treeDepthMax, 'Rich text nesting is bounded');
  return nodes.flatMap((node): readonly unknown[] => {
    if (node.kind === 'text') {
      const value = node.value.replace(/\s+/g, ' ').trim();
      return value === '' ? [] : [value];
    }
    if (node.kind === 'expr') {
      return [node.value];
    }
    return [{ name: node.name, props: node.props, children: node.children === undefined ? undefined : richShape(node.children, depth + 1) }];
  });
}
