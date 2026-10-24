import { useEffect, useRef, useState } from 'react';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { containsHTML, editableHTML } from './htmlFieldModel';
import { HtmlToolbar, type HTMLCommand } from './HtmlToolbar';
import './contentInputs.css';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  readonly onChange: (value: string) => void;
}

export default function HtmlField({ value, label = 'Rich text', onChange }: Props) {
  const host = useRef<HTMLDivElement>();
  const selection = useRef<Range>();
  const emitted = useRef<string>();
  const [source, setSource] = useState(false);
  const projection = editableHTML(value, document);
  useEffect(() => {
    if (host.current && value !== emitted.current) {
      host.current.innerHTML = projection.html;
      emitted.current = value;
    }
  }, [value, projection.html, source]);
  const emit = (): void => {
    const element = host.current;
    if (!element) {
      return;
    }
    // Always leave a paragraph when emptied so the HTML field keeps its editor.
    const html = editableHTML(element.innerHTML, document).html;
    const next = containsHTML(html) ? html : `<p>${html}</p>`;
    emitted.current = next;
    onChange(next);
  };
  const rememberSelection = (): void => {
    const current = window.getSelection();
    if (current?.rangeCount && host.current?.contains(current.anchorNode)) {
      selection.current = current.getRangeAt(0).cloneRange();
    }
  };
  const command = (action: HTMLCommand): void => {
    const element = host.current;
    if (!element || projection.restricted) {
      return;
    }
    element.focus();
    if (selection.current && element.contains(selection.current.commonAncestorContainer)) {
      const current = window.getSelection();
      current?.removeAllRanges();
      current?.addRange(selection.current);
    }
    document.execCommand(action.name, false, action.value);
    rememberSelection();
    emit();
  };
  return (
    <div className="html-field">
      <HtmlToolbar
        source={source}
        toggleSource={() => {
          emitted.current = undefined;
          setSource(!source);
        }}
        command={command}
        rememberSelection={rememberSelection}
      />
      <HtmlBody
        {...{ value, label, source, projection, emit, rememberSelection }}
        setHost={(element) => {
          host.current = element ?? undefined;
        }}
        onChange={onChange}
      />
    </div>
  );
}

interface BodyProps extends Props {
  readonly source: boolean;
  readonly projection: ReturnType<typeof editableHTML>;
  readonly emit: () => void;
  readonly rememberSelection: () => void;
  readonly setHost: (element: HTMLDivElement | undefined) => void;
}
function HtmlBody(props: BodyProps) {
  if (props.source) {
    return (
      <textarea
        className="html-source"
        aria-label={`${props.label} HTML`}
        key={props.value}
        defaultValue={props.value}
        rows={6}
        maxLength={BOUNDARY_LIMITS.textLengthMax}
        // Commit source on blur: incomplete tags must not swap out the focused editor.
        onBlur={(event) => {
          if (event.target.value !== props.value) {
            props.onChange(event.target.value);
          }
        }}
      />
    );
  }
  return (
    <>
      {props.projection.restricted && (
        <div className="html-notice">
          This HTML includes markup that cannot be edited visually. Use HTML to preserve it.
        </div>
      )}
      <div
        ref={(element) => props.setHost(element ?? undefined)}
        className="html-content"
        role="textbox"
        aria-label={props.label}
        aria-multiline="true"
        aria-readonly={props.projection.restricted}
        contentEditable={!props.projection.restricted}
        suppressContentEditableWarning
        onInput={props.emit}
        onMouseUp={props.rememberSelection}
        onKeyUp={props.rememberSelection}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a')) {
            event.preventDefault();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          // Plain text paste avoids importing styles, tracking images or executable markup.
          document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
          props.emit();
        }}
        onDrop={(event) => event.preventDefault()}
      />
    </>
  );
}
