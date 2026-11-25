import { allowDragEffect } from '../../editor/dragState';
import { useRef, useState, type DragEvent } from 'react';
import { useTreeDragCleanup } from '../../ui/TreeDragDrop';
import { pageOrderKey, pageOrderParent, reorderPageEntries, type PageOrder } from '../../../shared/properties/pageOrder';

const PAGE_ORDER_DRAG_TYPE = 'application/x-stacki-page-order';
interface DropTarget {
  readonly parent: string;
  readonly index: number;
}
interface Options {
  readonly order: PageOrder;
  readonly enabled: boolean;
  readonly save: (order: PageOrder) => void;
}

export type PageOrderDrag = ReturnType<typeof usePageOrderDrag>;
export function usePageOrderDrag({ order, enabled, save }: Options) {
  const source = useRef<string>();
  const [target, setTarget] = useState<DropTarget>();
  const [parent, setParent] = useState<string>();
  const finish = () => {
    source.current = undefined;
    setTarget(undefined);
    setParent(undefined);
  };
  useTreeDragCleanup(finish);
  return {
    enabled,
    target,
    parent,
    start: (event: DragEvent<HTMLElement>, key: string) => {
      event.stopPropagation();
      source.current = key;
      setParent(pageOrderParent(key).replace(/\/$/, ''));
      event.dataTransfer.setData(PAGE_ORDER_DRAG_TYPE, key);
      allowDragEffect(event.dataTransfer, 'move');
    },
    accepts: (event: DragEvent<HTMLElement>, parent: string) =>
      enabled &&
      event.dataTransfer.types.includes(PAGE_ORDER_DRAG_TYPE) &&
      source.current !== undefined &&
      pageOrderParent(source.current) === (parent ? parent + '/' : ''),
    enter: (parent: string, index: number) => setTarget({ parent, index }),
    drop: (event: DragEvent<HTMLElement>, siblings: readonly string[], index: number) => {
      const current = pageOrderKey(event.dataTransfer.getData(PAGE_ORDER_DRAG_TYPE));
      finish();
      const anchor = siblings[index] ?? siblings.at(-1);
      if (!enabled || current === undefined || anchor === undefined) {
        return;
      }
      const next = reorderPageEntries(order, siblings, {
        source: current,
        target: anchor,
        position: index < siblings.length ? 'before' : 'after',
      });
      save(next);
    },
    clearTarget: () => setTarget(undefined),
    finish,
  };
}
