// An element's Attributes connected to the component's attributes prop (its
// rest props, attributesBinding.ts), as a builder shows one: the header's
// purple dot opens "New Attributes property" and the props it can connect
// to; once connected, a purple chip naming the prop takes the dot's place,
// and its menu offers Edit settings (the tooltip and the defaults written
// before the spread), Disconnect, a new prop, and the prop it is connected to,
// checked. Only in a component: on a page there is no prop to connect.

import { useCallback, useState } from 'react';
import type { RefCallback } from 'react';
import { BracesIcon, CheckIcon, ChevronDownIcon, CloseIcon, ComponentIcon, GearIcon, PlusIcon, UnlinkIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import { boundAttributes, readAttributesBinding, unboundAttributes } from '../../editor/attributesBinding';
import { restTooltip, withRestTooltip, type AttributeDefault } from '../../editor/propDeclaration';
import { dataPickerPosition } from './dataPickerPosition';
import { BindHandle, FieldDataPicker, type FieldPosition } from './propBindings';
import type { RichContext } from './RichContent';
import { AttributeDefaultsEditor } from './NewPropForm';
import { RowPopup } from './LoopRows';
import './loopSettings.css';

type Props = Readonly<Record<string, Attr | undefined>>;

export interface AttributesPropProps {
  readonly props: Props | undefined;
  /** The element's tag: an attributes prop is typed by it. */
  readonly tag: string;
  readonly bindContext: RichContext | undefined;
  readonly onReplaceProps: (props: Readonly<Record<string, Attr>>) => void;
  readonly onSetFrontmatter: ((source: string) => void) | undefined;
}

type Panel = 'menu' | 'settings' | 'new' | undefined;

/** The header control: the bind dot, or the chip of the prop the attributes are connected to. */
export function AttributesPropControl(props: AttributesPropProps) {
  const host = props.bindContext?.newProp;
  const local = host?.restLocal;
  const bound = local !== undefined && readAttributesBinding(props.props, local) !== undefined;
  const [picker, setPicker] = useState<FieldPosition | undefined>(undefined);
  if (host === undefined) {
    return undefined;
  }
  if (bound) {
    return <BoundChip {...props} local={local} />;
  }
  return (
    <>
      <BindHandle
        active={picker !== undefined}
        onOpen={(element) => {
          const bounds = element?.getBoundingClientRect();
          setPicker(picker !== undefined || bounds === undefined ? undefined : dataPickerPosition(bounds));
        }}
      />
      {picker !== undefined && (
        <FieldDataPicker
          pos={picker}
          bindContext={props.bindContext}
          seed={{ fit: 'attributes', label: 'Custom attributes', value: '', tag: props.tag }}
          onBindNew={(path, declaration) => {
            setPicker(undefined);
            props.onReplaceProps(boundAttributes(props.props, path, declaration.attributes));
          }}
          onPick={(path) => {
            setPicker(undefined);
            props.onReplaceProps(boundAttributes(props.props, path, []));
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
    </>
  );
}

function BoundChip(props: AttributesPropProps & { readonly local: string }) {
  const [panel, setPanel] = useState<Panel>(undefined);
  const [chip, setChip] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setChip(element ?? undefined), []);
  const close = (): void => setPanel(undefined);
  return (
    <>
      <button
        ref={attach}
        type="button"
        className="attrs-bound-chip"
        aria-haspopup="menu"
        aria-expanded={panel !== undefined}
        title={`Instances add attributes through ${props.local}`}
        onClick={() => setPanel(panel === undefined ? 'menu' : undefined)}
      >
        <BracesIcon size={11} />
        {props.local}
        <ChevronDownIcon size={10} />
      </button>
      {panel === 'menu' && (
        <RowPopup anchor={chip} label="Attributes property" onClose={close}>
          <BoundMenu {...props} onPanel={setPanel} />
        </RowPopup>
      )}
      {panel === 'settings' && (
        <RowPopup anchor={chip} label="Property settings" onClose={close}>
          <AttributesSettings {...props} onClose={close} />
        </RowPopup>
      )}
    </>
  );
}

function BoundMenu(props: AttributesPropProps & { readonly local: string; readonly onPanel: (panel: Panel) => void }) {
  const host = props.bindContext?.newProp;
  assert(host !== undefined, 'A connected attributes list is in a component');
  return (
    <div className="loop-linked-menu" role="menu">
      <button type="button" role="menuitem" className="loop-linked-item" onClick={() => props.onPanel('settings')}>
        <GearIcon size={14} />
        Edit settings
      </button>
      <button
        type="button"
        role="menuitem"
        className="loop-linked-item"
        onClick={() => {
          props.onPanel(undefined);
          props.onReplaceProps(unboundAttributes(props.props, props.local));
        }}
      >
        <UnlinkIcon size={14} />
        Disconnect
      </button>
      <button
        type="button"
        role="menuitem"
        className="loop-linked-item accent"
        disabled={true}
        title={`A component passes its other attributes on once, as ${props.local}.`}
      >
        <PlusIcon size={14} />
        New Attributes property
      </button>
      <div className="loop-linked-heading">Connect</div>
      <div className="loop-linked-component">
        <ComponentIcon size={13} />
        {host.componentName}
      </div>
      <button type="button" role="menuitemradio" aria-checked={true} className="loop-linked-item loop-linked-prop" onClick={() => props.onPanel(undefined)}>
        <BracesIcon size={13} />
        <span className="loop-linked-name">{props.local}</span>
        <CheckIcon size={13} className="loop-linked-check" />
      </button>
    </div>
  );
}

// The prop's tooltip (above `interface Props`) and this element's defaults
// (the attributes before its spread), each saved as it is left.
function AttributesSettings(props: AttributesPropProps & { readonly local: string; readonly onClose: () => void }) {
  const frontmatter = props.bindContext?.frontmatter ?? '';
  const [tooltip, setTooltip] = useState(() => restTooltip(frontmatter));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The rows as edited, so a row still being named stays on screen while the
  // file only ever holds named ones.
  const [rows, setRows] = useState<readonly AttributeDefault[]>(() => readAttributesBinding(props.props, props.local)?.defaults ?? []);
  const saveTooltip = (): void => {
    if (tooltip.trim() === restTooltip(frontmatter) || props.onSetFrontmatter === undefined) {
      return;
    }
    const next = withRestTooltip(frontmatter, tooltip);
    if (next.ok) {
      setProblem(undefined);
      props.onSetFrontmatter(next.value);
    } else {
      setProblem(next.error);
    }
  };
  const setDefaults = (next: readonly AttributeDefault[]): void => {
    setRows(next);
    props.onReplaceProps(
      boundAttributes(
        props.props,
        props.local,
        next.filter((entry) => entry.name !== ''),
      ),
    );
  };
  return (
    <div className="loop-bind-dialog loop-property-settings new-prop-form">
      <div className="loop-property-head">
        <span className="loop-bind-title">Property settings</span>
        <button type="button" className="loop-settings-remove" aria-label="Close property settings" title="Close" onClick={props.onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="loop-bind-name">
        <span className="loop-settings-editor-label">Name</span>
        <span className="loop-bind-chip">{props.local}</span>
      </div>
      <label className="loop-bind-name top">
        <span className="loop-settings-editor-label">Tooltip</span>
        <AutoTextarea
          value={tooltip}
          aria-label="Tooltip"
          placeholder="Describe how to use this property…"
          onChange={(event) => setTooltip(event.target.value)}
          onBlur={saveTooltip}
        />
      </label>
      {problem !== undefined && <div className="loop-bind-problem">{problem}</div>}
      <div className="loop-property-default">
        <div className="loop-bind-title">Default Attributes</div>
        <AttributeDefaultsEditor defaults={rows} onChange={setDefaults} />
      </div>
    </div>
  );
}
