// Rich text in the Properties panel. On an instance whose content (or set:html prop) has rich text on, the field
// becomes an Edit rich text button that opens the rich text editor in a dialog, with a `{}` beside the label that
// shows the same content as code. Content the editor cannot give back unchanged opens as code alone, and the toggle's
// tooltip says why (richTextContent.ts).
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import TipAnchor from '../../ui/TipAnchor';
import Popup from '../../ui/Popup';
import HtmlField from '../../ui/HtmlField';
import CodeEditor from '../../ui/CodeEditor';
import { BracesIcon } from '../../ui/Icons';
import type { InlineNode } from './richContentModel';
import { richTextNodes, richTextView, sameRichContent, type RichTextCodeReason } from './richTextContent';
import { CAPTION_LABEL_FOR } from '../../ui/captionLabel';
import { ResetLabel } from '../../ui/ResetLabel';
import type { PropFieldProvenance } from './propFieldExtras';
import './propFieldExtras.css';

export { sameRichContent } from './richTextContent';

const CODE_REASON_TIPS: Readonly<Record<RichTextCodeReason, MessageKey>> = {
  expression: 'props.richText.codeExpression',
  component: 'props.richText.codeComponent',
  markup: 'props.richText.codeMarkup',
  size: 'props.richText.codeSize',
};

export function RichTextContentField(props: {
  readonly label: string;
  /** Where the content comes from when it is not the field's own, and how it is cleared back (a canvas frame). */
  readonly provenance?: PropFieldProvenance | undefined;
  readonly own?: boolean | undefined;
  readonly onReset?: (() => void) | undefined;
  /** The content as written between the instance's tags; undefined when there is none. */
  readonly source: string | undefined;
  /** Writes the editor's content as the instance's children; or, for HTML a prop holds, `onSetHTML` writes it as text. */
  readonly onSetNodes?: ((nodes: readonly InlineNode[]) => void) | undefined;
  readonly onSetHTML?: ((html: string) => void) | undefined;
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
      {/* The label row every prop field has: the name, then the `{}` that switches the field to its code. */}
      <label htmlFor={CAPTION_LABEL_FOR} onClick={(event) => event.preventDefault()}>
        {props.onReset === undefined ? (
          <span className="prop-label">{props.label}</span>
        ) : (
          <span className={props.provenance?.tone === 'inherited' ? 'prop-label-holder inherited' : 'prop-label-holder'} title={props.provenance?.tip}>
            <ResetLabel label={props.label} active={props.own === true} onReset={props.onReset} />
          </span>
        )}
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
      </label>
      {view === 'code' ? (
        <RichTextCode source={props.source ?? ''} onSetSource={props.onSetSource} />
      ) : (
        <button type="button" className="props-rich-text-edit" onClick={() => setOpen(true)}>
          {translate('props.richText.edit')}
        </button>
      )}
      {open && decision.view === 'rich' && (
        <RichTextDialog
          label={props.label}
          html={decision.html}
          onWrite={(html) => {
            props.onSetHTML?.(html);
            props.onSetNodes?.(richTextNodes(html, document));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// The editor in a dialog. It keeps the HTML it emitted: the page writes it back as the printer lays it out, which is the
// same content in other whitespace, and putting that into the editor would move the caret. Content that changes in
// any other way (a canvas edit, undo) is someone else's and replaces what the editor shows.
function RichTextDialog(props: { readonly label: string; readonly html: string; readonly onWrite: (html: string) => void; readonly onClose: () => void }) {
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
      {({ close }) => (
        <>
          <div className="modal-header">{props.label}</div>
          <div className="modal-body">
            <HtmlField
              value={draft}
              label={props.label}
              blocks="insert"
              onChange={(html) => {
                written.current = html;
                setDraft(html);
                props.onWrite(html);
              }}
            />
          </div>
          {/* Every change is already written, so the one button closes, as a finished publish's dialog does. */}
          <div className="modal-footer">
            <button type="button" className="primary" onClick={close}>
              {translate('ui.close')}
            </button>
          </div>
        </>
      )}
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
