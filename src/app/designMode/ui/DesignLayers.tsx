// The frame's layers: its elements as a tree, named as the hand-off names them (component, or tag and class),
// with the selection's ancestors open. Click selects, Shift-click adds, the eye hides or shows. Rows are
// built only for open branches, and each branch shows at most CHILDREN_SHOWN_MAX children.
import { useState } from 'react';
import { DESIGN_ID_ATTRIBUTE, INSTANCE_ATTRIBUTE } from '../model/designPrepare';
import { designIdOf, isHidden, setHidden } from '../model/designDom';
import type { DesignElementId, FrameId } from '../model/designTypes';
import { commitFrame, frameDocument, instanceInfo, select, selectedElements, useDesignState } from '../runtime/designSession';
import type { DesignWords } from '../i18n/designWords';
import { ChevronIcon, ComponentToolIcon, HideIcon, ShowIcon } from './designIcons';

const CHILDREN_SHOWN_MAX = 200;
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);

function layerName(frame: FrameId, element: Element): string {
  const key = element.getAttribute(INSTANCE_ATTRIBUTE);
  const instance = key === null ? undefined : instanceInfo(frame, key);
  if (instance !== undefined) {
    return instance.name;
  }
  const tag = element.tagName.toLowerCase();
  const firstClass = (element.getAttribute('class') ?? '').split(/\s+/).find((name) => name !== '' && !name.startsWith('astro-'));
  const text = element.childElementCount === 0 ? (element.textContent ?? '').trim().slice(0, 40) : '';
  return (firstClass === undefined ? tag : tag + '.' + firstClass) + (text === '' ? '' : ' · ' + text);
}

export function DesignLayers({ frame, words }: { readonly frame: FrameId; readonly words: DesignWords }) {
  const state = useDesignState();
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const document = frameDocument(frame);
  const body = document?.body;
  if (body === undefined || body === null) {
    return undefined;
  }
  const selected = selectedElements();
  const selectedIds = new Set(selected?.frame === frame ? selected.elements.map((element) => element.getAttribute(DESIGN_ID_ATTRIBUTE) ?? '') : []);
  // The selection's ancestors stay open, so the selected row is always in view.
  const open = new Set(opened);
  for (const element of selected?.frame === frame ? selected.elements : []) {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      open.add(parent.getAttribute(DESIGN_ID_ATTRIBUTE) ?? '');
    }
  }
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setOpened(next);
  };
  const rows: React.ReactNode[] = [];
  const pending: { readonly element: Element; readonly depth: number }[] = [...body.children]
    .slice(0, CHILDREN_SHOWN_MAX)
    .map((element) => ({ element, depth: 0 }));
  for (let visited = 0; pending.length > 0 && visited < 4_000; visited += 1) {
    const entry = pending.shift();
    if (entry === undefined || SKIPPED.has(entry.element.tagName)) {
      continue;
    }
    const { element, depth } = entry;
    const id = element.getAttribute(DESIGN_ID_ATTRIBUTE) ?? '';
    const children = [...element.children].filter((child) => !SKIPPED.has(child.tagName));
    const expanded = open.has(id);
    const hidden = isHidden(element);
    rows.push(
      <div
        key={id + String(visited)}
        className={`dm-layer${selectedIds.has(id) ? ' is-selected' : ''}${hidden ? ' is-hidden' : ''}`}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        onClick={(event) => {
          const designId = designIdOf(element);
          if (designId === undefined) {
            return;
          }
          const current =
            selected?.frame === frame ? selected.elements.map(designIdOf).filter((candidate): candidate is DesignElementId => candidate !== undefined) : [];
          select({ frame, ids: event.shiftKey ? [...current, designId] : [designId] });
        }}
      >
        <button
          type="button"
          className={`dm-layer-twisty${children.length === 0 ? ' is-empty' : ''}${expanded ? ' is-open' : ''}`}
          aria-label={layerName(frame, element)}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            toggle(id);
          }}
        >
          {children.length > 0 && <ChevronIcon size={12} />}
        </button>
        {element.hasAttribute(INSTANCE_ATTRIBUTE) && <ComponentToolIcon size={12} className="dm-layer-kind" />}
        <span className="dm-layer-name">{layerName(frame, element)}</span>
        <button
          type="button"
          className="dm-layer-eye"
          aria-label={words('layers.toggle')}
          onClick={(event) => {
            event.stopPropagation();
            commitFrame(frame, () => {
              setHidden(element, hidden ? 'shown' : 'hidden');
              return undefined;
            });
          }}
        >
          {hidden ? <HideIcon size={12} /> : <ShowIcon size={12} />}
        </button>
      </div>,
    );
    if (expanded) {
      const shown = children.slice(0, CHILDREN_SHOWN_MAX).map((child) => ({ element: child, depth: depth + 1 }));
      pending.unshift(...shown);
      if (children.length > CHILDREN_SHOWN_MAX) {
        rows.push(
          <div key={id + 'more'} className="dm-layer dm-muted" style={{ paddingInlineStart: 22 + (depth + 1) * 14 }}>
            {words('layers.more', { count: children.length - CHILDREN_SHOWN_MAX })}
          </div>,
        );
      }
    }
  }
  return (
    <div className="dm-layers" role="tree" aria-label={words('inspector.layers')} data-revision={state.revision}>
      {rows}
    </div>
  );
}
