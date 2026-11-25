// An inherited value has provenance but nothing local to reset. Its source is
// navigable only when the preview path resolves in the current document tree.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Popup from '../../../ui/Popup';
import type { StyleSource } from '../../../../shared/properties/styleSource';
import { getHost, walkNodes } from '../model/host';
import { ProvenanceLabel } from './CssPropertyTip';
import { useAnchoredPosition } from './provenancePosition';

export default function InheritedPropertyLabel({
  children,
  property,
  source,
  disabled,
  className,
}: {
  readonly children: ReactNode;
  readonly property: string;
  readonly source: StyleSource;
  readonly disabled: boolean;
  readonly className: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | undefined>(undefined);
  const suppress = useRef(false);
  return (
    <>
      <ProvenanceLabel
        label={children}
        props={[property]}
        className={className}
        busy={disabled}
        onProvenance={(_, rect) => {
          if (suppress.current) {
            suppress.current = false;
          } else {
            setAnchor(rect);
          }
        }}
      />
      {anchor ? (
        <InheritedPropertyPopover
          property={property}
          source={source}
          anchor={anchor}
          onClose={() => setAnchor(undefined)}
          onAnchorReclick={() => {
            suppress.current = true;
          }}
        />
      ) : undefined}
    </>
  );
}

function InheritedPropertyPopover({
  property,
  source,
  anchor,
  onClose,
}: {
  readonly property: string;
  readonly source: StyleSource;
  readonly anchor: DOMRect;
  readonly onClose: () => void;
  readonly onAnchorReclick: () => void;
}) {
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(ref, anchor);
  const target = inheritedTarget(source);
  const content = <code className="embed-editor_provenance-sel embed-editor_provenance-source">{target.label}</code>;
  return (
    <Popup
      mode="popover"
      onClose={onClose}
      ref={ref}
      className="embed-editor_provenance"
      role="dialog"
      label={translate('styleModel.components.inherited.label', { property })}
      style={{ left: position.left, top: position.top }}
    >
      <div className="embed-editor_provenance-head">
        <span>{translate('styleModel.shared.valueComesFrom')}</span>
        <button type="button" className="embed-editor_icon-btn" aria-label={translate('ui.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      {target.id ? (
        <button
          type="button"
          className="embed-editor_provenance-item is-active is-clickable"
          title={translate('styleModel.components.inherited.select', { label: target.label })}
          onClick={() => {
            const current = inheritedTarget(source);
            if (current.id) {
              getHost().selectNode?.(current.id);
            }
            onClose();
          }}
        >
          {content}
        </button>
      ) : (
        <div className="embed-editor_provenance-item is-active">{content}</div>
      )}
    </Popup>
  );
}

function inheritedTarget(source: StyleSource) {
  const host = getHost();
  let id: string | undefined;
  let label = source.label;
  if (source.path !== undefined) {
    walkNodes(host.nodes, (node) => {
      if (host.pathOf?.(node.id) === source.path) {
        id = node.id;
        if (node.kind === 'component' && node.name) {
          label = `${node.name} (${source.label})`;
        }
      }
    });
  }
  return { id, label };
}
