import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorRole } from '../roles/useEditorRole';
import StructurePanel from '../../../vendor/stacki/src/features/structure/StructurePanel';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { DropLocation } from '../../../vendor/stacki/src/features/structure/structureModel';
import { dropTarget } from './dropTarget';
import { movedTree, planCanvasMove, type CanvasMove } from '../../../vendor/stacki/shared/page/canvasMove';
import { pathFor } from '../project/previewSelection';
import { flatten, parsePage, type TreeAction } from '../source/source';
import type { SharedDocument } from '../collaboration/useDocument';
import { useTouchTree } from './useTouchTree';
import { studioElementActions } from './studioElementActions';
import type { Component } from '../project/projectClient';

export interface NavigatorProps {
  readonly editRootId?: string | undefined;
  readonly setDefaults?: (name: string, id: string) => void;
  readonly components: readonly Component[];
  readonly document: SharedDocument | undefined;
  readonly selected: string;
  readonly select: (id: string) => void;
  readonly hover: (id: string | undefined) => void;
  readonly action: (action: TreeAction) => void;
  /** A reorder, with the move the canvas can show before the server answers. */
  readonly move: (action: TreeAction, canvasMove: CanvasMove | undefined) => void;
  readonly insert: (file: string, target?: DropLocation) => void;
  readonly openCode: () => void;
  readonly openCodeWindow: (id: string) => void;
  readonly openComponent: (name: string, id: string) => void;
  readonly report: (error: unknown) => void;
}
export function Navigator(props: NavigatorProps) {
  const client = useEditorRole() === 'client';
  const source = props.document?.text.toString() ?? '';
  const parsed = useMemo(() => parsePage(source, { locs: true }), [source]);
  const wrapper = useRef<HTMLDivElement>(null);
  useTouchTree(wrapper);
  const shown = useShownMove(source, props.document?.revision ?? 0);
  const pageState = useMemo(() => {
    if (!parsed.editable) {
      return { editable: false as const, source, reason: parsed.reason };
    }
    // The order the drop asked for, until the server's answer replaces the source.
    // Plain records: parsePageModel checks what it is given, so the moved copy is
    // validated like the parse itself.
    const plain: readonly LooseNode[] = parsed.model.nodes;
    const moved = shown.move === undefined ? undefined : movedTree(plain, shown.move, (node, children) => ({ ...node, children }));
    const all = moved ?? plain;
    return {
      editable: true as const,
      model: parsePageModel({ ...parsed.model, nodes: client ? all.filter((node) => node.id === 'layout') : all }),
      source,
    };
  }, [parsed, source, client, shown.move]);
  const nodes = parsed.editable ? parsed.model.nodes : [];
  const move = (id: string, location: DropLocation) => {
    const destination = dropTarget(nodes, location);
    if (destination.target === id) {
      return;
    }
    // Planned over the order the Navigator shows; a drop made before the previous
    // one is answered plans over the server's order and shows on the canvas only then.
    const canvasMove = shown.move === undefined ? planCanvasMove(nodes, id, location, pathFor) : undefined;
    if (canvasMove !== undefined) {
      shown.show(canvasMove);
    }
    props.move({ kind: 'move', node: id, ...destination }, canvasMove);
  };
  return (
    <div className="studio-navigator" ref={wrapper}>
      <StructurePanel
        key={props.document?.ready ? props.document.file : 'loading'}
        {...studioElementActions(props, client ? 'client' : 'admin')}
        pageState={pageState}
        layouts={[]}
        currentLayoutName={nodes.find((node) => node.id === 'layout')?.name ?? ''}
        selectedId={props.selected}
        onSelect={props.select}
        onHoverNode={props.hover}
        {...(client ? {} : { onOpenCode: props.openCodeWindow })}
        onChangeLayout={() => props.openCode()}
        onDropComponent={props.insert}
        onMoveNode={move}
        onCodeChange={(text) => props.document?.replaceSource(text)}
        onOpenCodePanel={props.openCode}
        revealTick={flatten(nodes).findIndex((node) => node.id === props.selected)}
      />
    </div>
  );
}

// What the moved copy needs to know of a node; the copy keeps every other field.
interface LooseNode {
  readonly id?: string | undefined;
  readonly children?: readonly LooseNode[] | undefined;
}

// A drop's order, shown in the Navigator until the document changes (the server's
// answer) or the server refuses it. The move is forgotten on the first change, not
// merely hidden: an undo restores exactly the source it was planned over, and a hidden
// move would then show again over the restored order. The document's revision counts
// the change even when the answer and an undo land before React renders between them,
// which the source text alone cannot see (an undo pressed right after a drop).
function useShownMove(source: string, revision: number) {
  const [state, setState] = useState<{ readonly source: string; readonly revision: number; readonly move: CanvasMove } | undefined>(undefined);
  if (state !== undefined && (state.source !== source || state.revision !== revision)) {
    setState(undefined); // React re-renders before committing; the stale move never shows.
  }
  useEffect(() => {
    const refused = () => setState(undefined);
    window.addEventListener('studio:action-refused', refused);
    return () => window.removeEventListener('studio:action-refused', refused);
  }, []);
  return {
    move: state?.source === source && state.revision === revision ? state.move : undefined,
    show: (move: CanvasMove) => setState({ source, revision, move }),
  };
}
