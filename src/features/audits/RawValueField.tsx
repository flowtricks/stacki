// A raw value in the review window, editable in place with the Style panel's own
// value field. At rest it is the pill the window always showed; pressing or
// focusing it opens VariableConnect over a plain input, the combination the Style
// panel's length fields are made of, so typing, arrow-key stepping and the variable
// picker (a bound variable becomes a purple chip) behave exactly as they do there.
// Enter or leaving the field commits, Escape cancels, and a value the property will
// not accept stays open with the reason beside it. A commit is the fix pipeline's
// own: the one token's bytes are replaced (shared/page/auditValueEdit.ts), so an
// `!important`, the selector and the rule's formatting stay as written, and a row of
// identical values changes every member in one undo step.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuditFinding } from '../../../shared/page/auditFindings';
import { parseRawValue, valueFixes, type ValueRefusal, type ValueSupport } from '../../../shared/page/auditValueEdit';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import type { Actions } from './AuditsPanel';

/** What the app shell lends the review window: the Style panel's value input (features may not import each other) and what the property accepts. */
export interface RawValueKit {
  readonly Input: (props: RawValueInputProps) => ReactNode;
  readonly supports: ValueSupport;
}

export interface RawValueInputProps {
  readonly property: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly connectLabel: string;
  /** Every change of the text, typed or previewed. */
  readonly onChange: (next: string) => void;
  /** A variable picked: the finished value, `var(--name)`. */
  readonly onPick: (binding: string) => void;
  /** Focus left the field. */
  readonly onBlur: () => void;
}

export function RawValueField(props: { readonly findings: readonly AuditFinding[]; readonly actions: Actions; readonly kit: RawValueKit | undefined }) {
  const [first] = props.findings;
  const css = first?.css;
  if (first === undefined || css === undefined || props.kit === undefined || props.findings.some((finding) => finding.css?.place === undefined)) {
    return css === undefined ? undefined : (
      <strong className="audits-review-value">
        <CodeInline text={css.token} language="css" />
      </strong>
    );
  }
  return <EditableValue findings={props.findings} token={css.token} property={css.property} actions={props.actions} kit={props.kit} />;
}

function EditableValue(props: {
  readonly findings: readonly AuditFinding[];
  readonly token: string;
  readonly property: string;
  readonly actions: Actions;
  readonly kit: RawValueKit;
}) {
  const translate = useTranslate();
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<ValueRefusal | undefined>(undefined);
  const { property, token } = props;
  const count = props.findings.length;
  const close = (): void => {
    setRefusal(undefined);
    setEditing(false);
  };
  const commit = (typed: string): void => {
    const [first] = props.findings;
    const css = first?.css;
    if (css === undefined || typed.trim() === token) {
      close();
      return;
    }
    const parsed = parseRawValue(css, typed, props.kit.supports);
    if (!parsed.ok) {
      setRefusal(parsed.error);
      return;
    }
    const targets = valueFixes(props.findings, parsed.value);
    close();
    if (targets !== undefined) {
      void props.actions.fix(targets, `Set ${property} to ${parsed.value}`);
    }
  };
  if (!editing) {
    return (
      <button
        className="audits-review-value-button"
        title={translate('audits.review.value.edit', { property })}
        aria-label={translate('audits.review.value.edit', { property })}
        disabled={props.actions.busy}
        onClick={() => setEditing(true)}
        onFocus={() => setEditing(true)}
      >
        <strong className="audits-review-value">
          <CodeInline text={token} language="css" />
        </strong>
      </button>
    );
  }
  return (
    <ValueEditor
      property={property}
      token={token}
      busy={props.actions.busy}
      kit={props.kit}
      refusal={refusal}
      count={count}
      onCommit={commit}
      onCancel={close}
      onDraft={() => setRefusal(undefined)}
    />
  );
}

function ValueEditor(props: {
  readonly property: string;
  readonly token: string;
  readonly busy: boolean;
  readonly kit: RawValueKit;
  readonly refusal: ValueRefusal | undefined;
  readonly count: number;
  readonly onCommit: (typed: string) => void;
  readonly onCancel: () => void;
  readonly onDraft: () => void;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(props.token);
  const draftRef = useRef(props.token);
  const wrapRef = useRef<HTMLSpanElement>(null);
  // Escape sets this so the blur it causes does not commit what was typed.
  const cancelled = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const change = (next: string): void => {
    draftRef.current = next;
    setDraft(next);
    latest.current.onDraft();
  };
  useEffect(() => {
    wrapRef.current?.querySelector<HTMLElement>('[contenteditable], input')?.focus();
  }, []);
  // A press outside the field and its picker is leaving it, even when focus had already gone to the picker's search box.
  useEffect(() => {
    const press = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || wrapRef.current?.contains(target) === true || target.closest('.embed-editor_varpicker') !== null) {
        return;
      }
      latest.current.onCommit(draftRef.current);
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, []);
  const pickerOpen = (): boolean => document.querySelector('.embed-editor_varpicker') !== null;
  const label = translate('audits.review.value.label', { property: props.property });
  return (
    <span
      ref={wrapRef}
      className="audits-review-edit"
      onKeyDown={(event) => {
        // The picker is a portal inside this tree: its Escape closes it, not this field.
        if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('.embed-editor_varpicker') === null) {
          cancelled.current = true;
          props.onCancel();
        }
      }}
    >
      <props.kit.Input
        property={props.property}
        value={draft}
        disabled={props.busy}
        ariaLabel={label}
        connectLabel={translate('audits.review.value.connect', { property: props.property })}
        onChange={change}
        onPick={(binding) => {
          change(binding);
          props.onCommit(binding);
        }}
        onBlur={() => {
          // Focus moving into the variable picker is not leaving the field.
          if (!cancelled.current && !pickerOpen()) {
            props.onCommit(draftRef.current);
          }
        }}
      />
      {props.count > 1 && (
        <span className="audits-uses audits-review-edit-count" title={translate('audits.review.value.group', { count: props.count })}>
          {props.count}×
        </span>
      )}
      {props.refusal !== undefined && (
        <span className="audits-review-edit-error" role="alert">
          {translate(`audits.review.refused.${props.refusal}`, { property: props.property })}
        </span>
      )}
    </span>
  );
}
