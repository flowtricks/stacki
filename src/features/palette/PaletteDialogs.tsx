import { useTranslate, useTranslateDescribed, useTranslateRich } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import InfoHint from '../../ui/InfoHint';
import { SegmentedTabs, type SegmentedTab } from '../../ui/SegmentedTabs';
import { assert } from '../../../shared/core/assert';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import type { ExtractionPlan, ExtractionValue } from '../../editor/extractFrontmatter';
import type { ComponentUsageFile } from './paletteModel';
import { componentNameProblem, toComponentName } from './componentName';
import { prettyComponentName, usageFileLabel } from './paletteModel';
import { CloseIcon, ElementComponentIcon, FileIcon, LayoutIcon } from '../../ui/Icons';

export type ComponentCreationSource =
  | {
      readonly kind: 'ready';
      readonly name: string;
      readonly label: string;
      /** What creating would do with these values passed in as props and the rest moved. */
      readonly plan: (asProp: ReadonlySet<string>) => ExtractionPlan;
    }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly reasonRef?: TypedMessageRef | undefined };

export interface UsageAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export type UsagePopup =
  | { readonly kind: 'loading'; readonly name: string; readonly anchor: UsageAnchor }
  | {
      readonly kind: 'ready';
      readonly name: string;
      readonly anchor: UsageAnchor;
      readonly files: readonly ComponentUsageFile[];
    }
  | {
      readonly kind: 'error';
      readonly name: string;
      readonly anchor: UsageAnchor;
      readonly message: string;
    };

interface CreateComponentModalProps {
  readonly source: Extract<ComponentCreationSource, { readonly kind: 'ready' }>;
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onCreate: (name: string, options: { readonly asProp: readonly string[] }) => void;
}

export function CreateComponentModal(props: CreateComponentModalProps) {
  const [text, setText] = useState(props.source.name);
  // Empty is the default on purpose: every value moves unless the person says otherwise.
  const [asProp, setAsProp] = useState<ReadonlySet<string>>(new Set());
  const { plan: planFor } = props.source;
  const plan = useMemo(() => planFor(asProp), [planFor, asProp]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const name = toComponentName(text);
  const problem = componentNameProblem(text, props.taken);
  const error = problem === undefined ? undefined : translateDescribed(problem);
  const shown = text.trim() ? error : undefined;
  const submit = (): void => {
    if (problem === undefined) {
      props.onCreate(name, { asProp: [...asProp] });
    }
  };
  return (
    <Popup className="modal create-component" onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('palette.create.title')}</div>
          <div className="modal-body">
            <ComponentNameField
              inputRef={inputRef}
              text={text}
              setText={setText}
              name={name}
              error={shown}
              source={props.source}
              submit={submit}
              onClose={close}
            />
            <ValueChoices values={plan.values} asProp={asProp} onChange={setAsProp} />
          </div>
          <div className="modal-footer">
            <button onClick={close}>{translate('ui.cancel')}</button>
            <button className="primary" disabled={problem !== undefined} onClick={submit}>
              {translate('palette.create.submit')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function ComponentNameField({
  inputRef,
  text,
  setText,
  name,
  error,
  source,
  submit,
  onClose,
}: {
  readonly inputRef: React.RefObject<HTMLInputElement>;
  readonly text: string;
  readonly setText: React.Dispatch<React.SetStateAction<string>>;
  readonly name: string;
  readonly error: string | undefined;
  readonly source: Extract<ComponentCreationSource, { readonly kind: 'ready' }>;
  readonly submit: () => void;
  readonly onClose: () => void;
}) {
  const translateRich = useTranslateRich();
  const translate = useTranslate();
  return (
    <div>
      <label>{translate('palette.create.name')}</label>
      <input
        ref={inputRef}
        value={text}
        spellCheck={false}
        // i18n-ignore: an example component identifier, not prose.
        placeholder="Card"
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            submit();
          } else if (event.key === 'Escape') {
            onClose();
          }
        }}
      />
      {error ? (
        <ErrorToast message={error} />
      ) : (
        <div className="hint-text component-name-hint">
          {translateRich('palette.create.hint', {
            label: source.label,
            tag: <code>&lt;{name || 'Name'} /&gt;</code>,
            file: <code>src/components/{name || 'Name'}.astro</code>,
          })}
        </div>
      )}
    </div>
  );
}

type ValueChoice = 'move' | 'prop';
/** The bulk control's state: one choice for every value that has one, or `mixed` when they differ. */
type BulkChoice = ValueChoice | 'mixed';

/** The most values a dialog lists; a piece reading more is a caller bug, not a list to draw. */
const VALUE_ROWS_MAX = 256;

// What the page does with each value the piece reads. Move leads because the
// section and its data belong together; a value that can't move says why, in place
// of a choice it doesn't have. The header summarises and sets every row at once; the
// rows are one compact filled list that scrolls inside the dialog, so Create stays in view.
function ValueChoices({
  values,
  asProp,
  onChange,
}: {
  readonly values: readonly ExtractionValue[];
  readonly asProp: ReadonlySet<string>;
  readonly onChange: (asProp: ReadonlySet<string>) => void;
}) {
  const translate = useTranslate();
  if (values.length === 0) {
    return undefined;
  }
  assert(values.length <= VALUE_ROWS_MAX, 'ValueChoices: the values fit the list');
  const choosable = values.filter((value) => value.kind !== 'locked');
  const choose = (name: string, choice: ValueChoice): void => {
    const next = new Set(asProp);
    if (choice === 'prop') {
      next.add(name);
    } else {
      next.delete(name);
    }
    onChange(next);
  };
  // A locked value is already a prop and has no choice, so the bulk control leaves it alone.
  const chooseAll = (choice: ValueChoice): void => {
    const next = new Set(asProp);
    for (const value of choosable) {
      if (choice === 'prop') {
        next.add(value.name);
      } else {
        next.delete(value.name);
      }
    }
    onChange(next);
  };
  const propCount = choosable.filter((value) => value.kind === 'prop').length;
  const bulk: BulkChoice = propCount === 0 ? 'move' : propCount === choosable.length ? 'prop' : 'mixed';
  const movedIn = values.filter((value) => value.kind === 'move').length;
  const passed = values.length - movedIn;
  const bulkTabs: readonly SegmentedTab<BulkChoice>[] = [
    { value: 'move', label: translate('palette.create.value.bulkMove') },
    { value: 'prop', label: translate('palette.create.value.bulkProp') },
  ];
  return (
    <div className="extract-values">
      <div className="extract-values-head">
        <label>{translate('palette.create.value.reads', { count: values.length })}</label>
        {choosable.length > 1 ? (
          <SegmentedTabs<BulkChoice>
            tabs={bulkTabs}
            value={bulk}
            label={translate('palette.create.value.bulkAria')}
            className={{ track: 'extract-bulk' }}
            onPick={(choice) => chooseAll(choice === 'prop' ? 'prop' : 'move')}
          />
        ) : undefined}
      </div>
      <div className="extract-value-list" onKeyDown={moveBetweenRows}>
        {values.map((value) => (
          <ValueRow key={value.name} value={value} onChoose={choose} />
        ))}
      </div>
      <div className="hint-text extract-values-foot">{translate('palette.create.value.counts', { moved: movedIn, props: passed })}</div>
    </div>
  );
}

// Up and Down walk the rows' choices, landing on each row's chosen segment, so a long list is
// scanned from the keyboard without tabbing through every button.
function moveBetweenRows(event: React.KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) {
    return;
  }
  const chosen = [...event.currentTarget.querySelectorAll<HTMLElement>('.extract-value [role="tab"][aria-selected="true"]')];
  const row = event.target instanceof Element ? (event.target.closest('.extract-value') ?? undefined) : undefined;
  const at = chosen.findIndex((element) => element.closest('.extract-value') === row);
  const target = chosen[at + step];
  if (at >= 0 && target !== undefined) {
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  }
}

function ValueRow({ value, onChoose }: { readonly value: ExtractionValue; readonly onChoose: (name: string, choice: ValueChoice) => void }) {
  const translate = useTranslate();
  const note = valueNote(value);
  const choices: readonly SegmentedTab<ValueChoice>[] = [
    { value: 'move', label: translate('palette.create.value.move') },
    { value: 'prop', label: translate('palette.create.value.prop') },
  ];
  return (
    <div className="extract-value">
      <CodeInline className="extract-value-name" text={value.name} language="typescript" />
      {value.kind === 'move' && note !== undefined ? (
        <span className="extract-value-tag">
          {translate('palette.create.value.alsoUsed')}
          <InfoHint text={note} />
        </span>
      ) : undefined}
      {value.kind === 'locked' ? (
        <span className="extract-value-fixed">
          {translate('palette.create.value.passed')}
          {note === undefined ? undefined : <InfoHint text={note} />}
        </span>
      ) : (
        <SegmentedTabs<ValueChoice>
          tabs={choices}
          value={value.kind}
          label={translate('palette.create.value.choiceAria', { name: value.name })}
          layout="equal"
          className={{ track: 'extract-value-choice' }}
          onPick={(choice) => onChoose(value.name, choice)}
        />
      )}
    </div>
  );
}

function valueNote(value: ExtractionValue): string | undefined {
  switch (value.kind) {
    case 'move':
      return value.note;
    case 'prop':
      return undefined;
    case 'locked':
      return value.reason;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

interface InstancesPopupProps {
  readonly popupRef: React.RefObject<HTMLDivElement>;
  readonly usage: UsagePopup;
  readonly here: readonly { readonly id: string }[];
  readonly onClose: () => void;
  readonly onOpen: (file: ComponentUsageFile) => void;
  readonly onSelect: (id: string) => void;
}

export function InstancesPopup({ popupRef, usage, here, onClose, onOpen, onSelect }: InstancesPopupProps) {
  const translate = useTranslate();
  const place = usePopupPlacement(usage, here.length, popupRef);
  return (
    <Popup
      mode="popover"
      onClose={onClose}
      className="instances-popup"
      style={{
        left: place?.left ?? usage.anchor.left,
        top: place?.top ?? usage.anchor.bottom + 6,
      }}
      ref={popupRef}
    >
      <div className="instances-head">
        <span>{translate('palette.instances.title', { name: prettyComponentName(usage.name) })}</span>
        <button className="ghost" aria-label={translate('ui.close')} onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <CurrentInstances name={usage.name} instances={here} onSelect={onSelect} />
      <UsageFiles usage={usage} hasCurrent={here.length > 0} onOpen={onOpen} />
    </Popup>
  );
}

function usePopupPlacement(
  usage: UsagePopup,
  currentCount: number,
  popupRef: React.RefObject<HTMLDivElement>,
): { readonly top: number; readonly left: number } | undefined {
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = popupRef.current;
    if (!element) {
      return;
    }
    const next = popupPosition(usage.anchor, element.offsetWidth, element.offsetHeight);
    setPlace((previous) => (previous?.top === next.top && previous.left === next.left ? previous : next));
  }, [currentCount, popupRef, usage]);
  return place;
}

function popupPosition(anchor: UsageAnchor, width: number, height: number): { readonly top: number; readonly left: number } {
  const margin = 8;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const below = anchor.bottom + 6;
  const top =
    !viewportHeight || below + height <= viewportHeight - margin
      ? below
      : Math.max(margin, Math.min(anchor.top - 6 - height, viewportHeight - margin - height));
  const left = viewportWidth ? Math.max(margin, Math.min(anchor.left, viewportWidth - margin - width)) : anchor.left;
  return { top, left };
}

function CurrentInstances({
  name,
  instances,
  onSelect,
}: {
  readonly name: string;
  readonly instances: readonly { readonly id: string }[];
  readonly onSelect: (id: string) => void;
}) {
  const translate = useTranslate();
  if (instances.length === 0) {
    return undefined;
  }
  return (
    <div className="instances-group">
      <div className="instances-label">{translate('palette.instances.onPage')}</div>
      {instances.map((instance, index) => (
        <button key={instance.id} type="button" className="instances-row" onClick={() => onSelect(instance.id)}>
          <span className="icon">
            <ElementComponentIcon size={13} />
          </span>
          <span className="instances-name">
            {prettyComponentName(name)} {instances.length > 1 ? index + 1 : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

function UsageFiles({
  usage,
  hasCurrent,
  onOpen,
}: {
  readonly usage: UsagePopup;
  readonly hasCurrent: boolean;
  readonly onOpen: (file: ComponentUsageFile) => void;
}) {
  const translate = useTranslate();
  return (
    <div className="instances-group">
      <div className="instances-label">{translate(hasCurrent ? 'palette.instances.otherFiles' : 'palette.instances.usedIn')}</div>
      {usage.kind === 'error' ? (
        <ErrorToast message={translate('palette.instances.readFailed', { message: usage.message })} />
      ) : usage.kind === 'loading' ? (
        <div className="instances-empty">{translate('palette.instances.looking')}</div>
      ) : usage.files.length === 0 ? (
        <div className="instances-empty">{translate(hasCurrent ? 'palette.instances.nowhereElse' : 'palette.instances.unused')}</div>
      ) : (
        usage.files.map((file) => <UsageFileRow key={file.rel} file={file} onOpen={onOpen} />)
      )}
    </div>
  );
}

function UsageFileRow({ file, onOpen }: { readonly file: ComponentUsageFile; readonly onOpen: (file: ComponentUsageFile) => void }) {
  return (
    <button type="button" className={`instances-row ${file.kind === 'page' ? 'is-page' : ''}`} title={file.rel} onClick={() => onOpen(file)}>
      <span className="icon">{usageFileIcon(file)}</span>
      <span className="instances-name">{usageFileLabel(file)}</span>
      <span className="instances-count">{file.count}</span>
    </button>
  );
}

function usageFileIcon(file: ComponentUsageFile): React.ReactNode {
  switch (file.kind) {
    case 'page':
      return <FileIcon size={13} />;
    case 'layout':
      return <LayoutIcon size={13} />;
    case 'component':
    case 'file':
      return <ElementComponentIcon size={13} />;
  }
}
