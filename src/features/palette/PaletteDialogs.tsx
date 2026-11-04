import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentUsageFile } from './paletteModel';
import { componentNameError, toComponentName } from './componentName';
import { prettyComponentName, usageFileLabel } from './paletteModel';
import { CloseIcon, ElementComponentIcon, FileIcon, LayoutIcon } from '../../ui/Icons';

export type ComponentCreationSource =
  | {
      readonly kind: 'ready';
      readonly name: string;
      readonly label: string;
      readonly props: readonly string[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

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
  readonly onCreate: (name: string, options: { readonly withProps: boolean }) => void;
}

export function CreateComponentModal(props: CreateComponentModalProps) {
  const [text, setText] = useState(props.source.name);
  const [withProps, setWithProps] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const name = toComponentName(text);
  const error = componentNameError(text, props.taken);
  const shown = text.trim() ? error : undefined;
  const submit = (): void => {
    if (!error) {
      props.onCreate(name, { withProps });
    }
  };
  return (
    <Popup className="modal" onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">Create component</div>
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
            <PropsOffer names={props.source.props} checked={withProps} onChange={setWithProps} />
          </div>
          <div className="modal-footer">
            <button onClick={close}>Cancel</button>
            <button className="primary" disabled={Boolean(error)} onClick={submit}>
              Create
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
  return (
    <div>
      <label>Name</label>
      <input
        ref={inputRef}
        value={text}
        spellCheck={false}
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
          {source.label} becomes <code>&lt;{name || 'Name'} /&gt;</code>, saved as <code>src/components/{name || 'Name'}.astro</code>
        </div>
      )}
    </div>
  );
}

function PropsOffer({
  names,
  checked,
  onChange,
}: {
  readonly names: readonly string[];
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  if (names.length === 0) {
    return undefined;
  }
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>
        Take {names.length === 1 ? 'this page value' : `these ${names.length} page values`} as props: <PropNames names={names} />
      </span>
    </label>
  );
}

function PropNames({ names }: { readonly names: readonly string[] }) {
  return names.map((name, index) => (
    <React.Fragment key={name}>
      {index > 0 ? ', ' : ''}
      <code>{name}</code>
    </React.Fragment>
  ));
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
        <span>{prettyComponentName(usage.name)} instances</span>
        <button className="ghost" aria-label="Close" onClick={onClose}>
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
  if (instances.length === 0) {
    return undefined;
  }
  return (
    <div className="instances-group">
      <div className="instances-label">On this page</div>
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
  return (
    <div className="instances-group">
      <div className="instances-label">{hasCurrent ? 'Other files with instances' : 'Used in'}</div>
      {usage.kind === 'error' ? (
        <ErrorToast message={`Couldn’t read the project — ${usage.message}`} />
      ) : usage.kind === 'loading' ? (
        <div className="instances-empty">Looking…</div>
      ) : usage.files.length === 0 ? (
        <div className="instances-empty">{hasCurrent ? 'Nowhere else.' : 'Not used anywhere yet.'}</div>
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
