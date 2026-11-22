// An element's Attributes connected to the component's attributes prop (its
// rest props, attributesBinding.ts), as a builder shows one: the header's
// purple +, right after the "Attributes" label, declares `rest` typed by the
// element's tag and spreads it there in one step (or spreads the rest binding
// the component already has: it passes attributes on once); once connected, a purple chip
// naming the prop takes the dot's place, and its menu offers Edit settings
// (the prop's name, renamed across the file, and its tooltip), Disconnect, a
// new prop, and the prop it is connected to, checked. In the list, the spread
// is the dim "+ items in {} rest" row (BoundSpreadRow): where an instance's
// attributes land. Disconnecting takes the spread out and, when nothing else
// reads the prop, the prop itself (restReleased, propDeclaration.ts), held
// for the same edit so it is one undo step. Only in a component: on a page
// there is no prop to connect.

import { useCallback, useState } from 'react';
import type { RefCallback } from 'react';
import { createPortal } from 'react-dom';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import FittedTooltip from '../../ui/FittedTooltip';
import { ErrorToast } from '../../ui/ErrorToast';
import { BracesIcon, CheckIcon, ChevronDownIcon, CloseIcon, ComponentIcon, GearIcon, HelpCircleIcon, PlusIcon, UnlinkIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import { boundAttributes, readAttributesBinding, unboundAttributes } from '../../editor/attributesBinding';
import { restTooltip, withRestTooltip } from '../../editor/propDeclaration';
import { restConnectOffer, type NewPropHost, type RestConnectOffer } from './newPropModel';
import type { RichContext } from './RichContent';
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
  /** Renames the rest binding across the file; a message says why it was refused. */
  readonly onRenameVariable?: ((rename: { readonly from: string; readonly to: string }) => string | undefined) | undefined;
}

/** The spread of the connected prop in the attribute list: where an instance's attributes are added. */
export function BoundSpreadRow({ local }: { readonly local: string }) {
  const translate = useTranslate();
  return (
    <div className="attr-row attrs-items-row" data-bound-spread={local}>
      <PlusIcon size={11} />
      <span className="attrs-items-label">{translate('props.attributesBinding.itemsIn')}</span>
      <span className="attrs-items-chip">
        <BracesIcon size={11} />
        <bdi>{local}</bdi>
      </span>
      <span
        className="attrs-items-help"
        role="img"
        aria-label={translate('props.attributesBinding.itemsHelp')}
        title={translate('props.attributesBinding.itemsHelp')}
      >
        <HelpCircleIcon size={12} />
      </span>
    </div>
  );
}

type Panel = 'menu' | 'settings' | 'new' | undefined;

/** The header control: the purple +, or the chip of the prop the attributes are connected to. */
export function AttributesPropControl(props: AttributesPropProps) {
  const host = props.bindContext?.newProp;
  const local = host?.restLocal;
  const bound = local !== undefined && readAttributesBinding(props.props, local) !== undefined;
  if (host === undefined) {
    return undefined;
  }
  if (bound) {
    return <BoundChip {...props} local={local} />;
  }
  const offer = restConnectOffer(host, { tag: props.tag, connected: false });
  if (offer === undefined) {
    return undefined;
  }
  return <ConnectButton {...props} host={host} offer={offer} />;
}

// The purple + right after the "Attributes" label, always shown (unlike a
// field's hover dot, which this header has no label element to reveal it):
// one press declares `rest` typed by this tag (`HTMLAttributes<"a">`, and its
// import) and spreads it here, or spreads the component's existing rest
// binding. `host.create` holds the declaration for the spread's edit, so the
// frontmatter and the tag are one undo step. A refusal (frontmatter with a
// syntax error, say) is reported, and nothing is written.
function ConnectButton(props: AttributesPropProps & { readonly host: NewPropHost; readonly offer: RestConnectOffer }) {
  const translate = useTranslate();
  const tip = useDelayedTooltip();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const { offer, host } = props;
  const label =
    offer.kind === 'declare' ? translate('props.attributesBinding.connectNew') : translate('props.attributesBinding.connectTo', { local: offer.local });
  const connect = (): void => {
    tip.hide();
    switch (offer.kind) {
      case 'declare': {
        const made = host.create(offer.declaration);
        if (made.ok) {
          setProblem(undefined);
          props.onReplaceProps(boundAttributes(props.props, made.value, []));
        } else {
          setProblem(made.error);
        }
        return;
      }
      case 'spread':
        props.onReplaceProps(boundAttributes(props.props, offer.local, []));
        return;
      default: {
        const exhaustive: never = offer;
        return exhaustive;
      }
    }
  };
  return (
    <>
      {/* The shared bind handle's dot and +: small at rest, grown into the + on hover or focus (styles.css .bind-handle). */}
      <button type="button" className="bind-handle attrs-connect" aria-label={label} onMouseEnter={tip.show} onMouseLeave={tip.hide} onClick={connect}>
        <span className="bind-dot" />
        <PlusIcon size={10} className="bind-plus" />
      </button>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value}>
            {label}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
      <ErrorToast message={problem} />
    </>
  );
}

function BoundChip(props: AttributesPropProps & { readonly local: string }) {
  const translate = useTranslate();
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
        title={translate('props.attributesBinding.through', { local: props.local })}
        onClick={() => setPanel(panel === undefined ? 'menu' : undefined)}
      >
        <BracesIcon size={11} />
        {props.local}
        <ChevronDownIcon size={10} />
      </button>
      {panel === 'menu' && (
        <RowPopup anchor={chip} label={translate('props.attributesBinding.property')} onClose={close}>
          <BoundMenu {...props} onPanel={setPanel} />
        </RowPopup>
      )}
      {panel === 'settings' && (
        <RowPopup anchor={chip} label={translate('props.newProp.form.settings')} onClose={close}>
          <AttributesSettings {...props} onClose={close} />
        </RowPopup>
      )}
    </>
  );
}

function BoundMenu(props: AttributesPropProps & { readonly local: string; readonly onPanel: (panel: Panel) => void }) {
  const translate = useTranslate();
  const host = props.bindContext?.newProp;
  assert(host !== undefined, 'A connected attributes list is in a component');
  return (
    <div className="loop-linked-menu" role="menu">
      <button type="button" role="menuitem" className="loop-linked-item" onClick={() => props.onPanel('settings')}>
        <GearIcon size={14} />
        {translate('props.attributesBinding.editSettings')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="loop-linked-item"
        onClick={() => {
          props.onPanel(undefined);
          // Held first, so the prop's removal and the spread's are one undo step.
          host.releaseRest?.(props.local);
          props.onReplaceProps(unboundAttributes(props.props, props.local));
        }}
      >
        <UnlinkIcon size={14} />
        {translate('props.attributesBinding.disconnect')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="loop-linked-item accent"
        disabled={true}
        title={translate('props.attributesBinding.passesOnce', { local: props.local })}
      >
        <PlusIcon size={14} />
        {translate('props.attributesBinding.newProperty')}
      </button>
      <div className="loop-linked-heading">{translate('props.attributesBinding.connect')}</div>
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

// The prop's name, renamed across the file as it is left, and its tooltip
// (above `interface Props`), each saved as it is left. The attributes an
// instance can override are the rows before the spread, edited in the list.
function AttributesSettings(props: AttributesPropProps & { readonly local: string; readonly onClose: () => void }) {
  const translate = useTranslate();
  const frontmatter = props.bindContext?.frontmatter ?? '';
  const [tooltip, setTooltip] = useState(() => restTooltip(frontmatter));
  const [name, setName] = useState(props.local);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const saveTooltip = (): void => {
    if (tooltip.trim() === restTooltip(frontmatter) || props.onSetFrontmatter === undefined) {
      return;
    }
    const next = withRestTooltip(frontmatter, tooltip, translate);
    if (next.ok) {
      setProblem(undefined);
      props.onSetFrontmatter(next.value);
    } else {
      setProblem(next.error);
    }
  };
  const saveName = (): void => {
    const next = name.trim();
    if (next === props.local || props.onRenameVariable === undefined) {
      return;
    }
    const refused = props.onRenameVariable({ from: props.local, to: next });
    setProblem(refused);
    if (refused !== undefined) {
      setName(props.local);
    }
  };
  return (
    <div className="loop-bind-dialog loop-property-settings new-prop-form">
      <div className="loop-property-head">
        <span className="loop-bind-title">{translate('props.newProp.form.settings')}</span>
        <button
          type="button"
          className="loop-settings-remove"
          aria-label={translate('props.attributesBinding.closeSettings')}
          title={translate('ui.close')}
          onClick={props.onClose}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">{translate('props.newProp.form.name')}</span>
        {props.onRenameVariable === undefined ? (
          <span className="loop-bind-chip">{props.local}</span>
        ) : (
          <input
            value={name}
            spellCheck={false}
            aria-label={translate('props.newProp.form.name')}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                saveName();
              }
            }}
          />
        )}
      </label>
      <label className="loop-bind-name top">
        <span className="loop-settings-editor-label">{translate('props.newProp.form.tooltip')}</span>
        <AutoTextarea
          value={tooltip}
          aria-label={translate('props.newProp.form.tooltip')}
          placeholder={translate('props.newProp.form.tooltipPlaceholder')}
          onChange={(event) => setTooltip(event.target.value)}
          onBlur={saveTooltip}
        />
      </label>
      {problem !== undefined && <div className="loop-bind-problem">{problem}</div>}
    </div>
  );
}
