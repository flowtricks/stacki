// A filter's or a sort's Field, chosen the way a loop's Source is: a tree of
// what one item holds, each row with its value from a sampled item beside it.
// An object opens to the fields inside it (`location` to `lat` and `lng`), so
// anything an item holds can be filtered and sorted by, not only its
// top-level fields. Rows a filter or a sort cannot use are shown for reading
// and not chosen. Extras (Custom code, Random order) sit above the tree.
//
// The tree is the data picker's own (DataPicker.tsx), built from the
// collection's fields (loopCatalog.ts), whose dotted paths say where each sits.

import { useCallback, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import DataPicker, { type PickerNode } from './DataPicker';
import { ChevronDownIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { sampleAt, samplePreview } from '../../editor/dataSample';
import type { CatalogField } from './loopCatalog';
import { fieldIcon, RowPopup } from './LoopRows';
import { useTranslate } from '../../lib/i18n/useTranslate';

const PICKER_HEIGHT_PX_MAX = 420;

/** A choice above the tree that is not a field: custom code, a shuffle. */
export interface FieldExtra {
  readonly value: string;
  readonly label: string;
  readonly icon: ReactNode;
}

export function FieldPicker(props: {
  /** The chosen field's path, or an extra's value. */
  readonly value: string;
  readonly fields: readonly CatalogField[];
  /** Whether a field can be chosen here: one a filter can test, or a sort can order. */
  readonly usable: (field: CatalogField) => boolean;
  /** One item, as its fields: each row's value is read from it. */
  readonly sample: unknown;
  readonly extras: readonly FieldExtra[];
  readonly onChange: (value: string) => void;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setAnchor(element ?? undefined), []);
  const choose = (value: string): void => {
    setOpen(false);
    props.onChange(value);
  };
  const field = props.fields.find((candidate) => candidate.path === props.value);
  const extra = props.extras.find((candidate) => candidate.value === props.value);
  return (
    <>
      <button
        ref={attach}
        type="button"
        className="dd-trigger loop-source-trigger"
        aria-label={translate('props.loop.field')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="dd-icon">{extra?.icon ?? (field === undefined ? undefined : fieldIcon(field.kind))}</span>
        <span className="dd-label">{extra?.label ?? field?.title ?? props.value}</span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>
      {open && (
        <RowPopup anchor={anchor} heightPxMax={PICKER_HEIGHT_PX_MAX} label={translate('props.loop.field')} onClose={() => setOpen(false)}>
          <div className="loop-source-picker">
            {props.extras.length > 0 && (
              <div className="loop-source-extras">
                {props.extras.map((candidate) => (
                  <button key={candidate.value} type="button" className="dp-row" onClick={() => choose(candidate.value)}>
                    {candidate.icon}
                    <span className="dp-key">{candidate.label}</span>
                  </button>
                ))}
              </div>
            )}
            <DataPicker
              tree={fieldTree(props.fields, props.sample, props.usable)}
              current={field?.path}
              footer={false}
              onPick={(path) => {
                if (props.fields.some((candidate) => candidate.path === path && props.usable(candidate))) {
                  choose(path);
                }
              }}
            />
          </div>
        </RowPopup>
      )}
    </>
  );
}

/**
 * The fields as a tree: a field sits under the field (or the bare name, for a
 * path like `slug.current` whose parent is not a field itself) its path
 * continues. Exported for its test.
 */
export function fieldTree(fields: readonly CatalogField[], sample: unknown, usable: (field: CatalogField) => boolean): readonly PickerNode[] {
  assert(fields.length <= LIMITS.treeNodesMax, 'A field tree is bounded');
  interface Building {
    readonly path: string;
    readonly key: string;
    readonly field: CatalogField | undefined;
    readonly children: Building[];
  }
  const roots: Building[] = [];
  const byPath = new Map<string, Building>();
  // Each step of a field's path gets a row, parents first, so a nested field
  // always has one to sit in; the last step is the field's own.
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  for (const field of fields) {
    const segments = field.path.split('.');
    assert(segments.length <= LIMITS.treeDepthMax, 'A field path is shallow');
    let siblings = roots;
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join('.');
      let node = byPath.get(path);
      if (node === undefined) {
        node = { path, key: segments[index] ?? path, field: fieldsByPath.get(path), children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  const finish = (node: Building, depth: number): PickerNode => {
    assert(depth <= LIMITS.treeDepthMax, 'A field tree is shallow');
    const field = node.field;
    const value = sampleAt(sample, node.path);
    const children = node.children.map((child) => finish(child, depth + 1));
    return {
      path: node.path,
      // Its own name: the title says where it sits, which the tree already shows.
      key: field === undefined ? node.key : (field.title.split(' › ').pop() ?? field.title),
      kind: field?.kind ?? 'object',
      preview: value === undefined ? '' : samplePreview(value),
      children: children.length > 0 ? children : undefined,
      pickable: field !== undefined && usable(field),
    };
  };
  return roots.map((root) => finish(root, 0));
}
