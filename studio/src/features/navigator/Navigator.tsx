import { useMemo, useRef } from 'react';
import { useEditorRole } from '../roles/useEditorRole';
import StructurePanel from '../../../vendor/stacki/src/features/structure/StructurePanel';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { DropLocation } from '../../../vendor/stacki/src/features/structure/structureModel';
import { dropTarget } from './dropTarget';
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
  const pageState = useMemo(
    () =>
      parsed.editable
        ? {
            editable: true as const,
            model: parsePageModel({
              ...parsed.model,
              nodes: client ? parsed.model.nodes.filter((node) => node.id === 'layout') : parsed.model.nodes,
            }),
            source,
          }
        : { editable: false as const, source, reason: parsed.reason },
    [parsed, source, client],
  );
  const nodes = parsed.editable ? parsed.model.nodes : [];
  const move = (id: string, location: DropLocation) => {
    const destination = dropTarget(nodes, location);
    if (destination.target !== id) {
      props.action({ kind: 'move', node: id, ...destination });
    }
  };
  return (
    <div className="studio-navigator" ref={wrapper}>
      <StructurePanel
        key={props.document?.ready ? props.document.file : 'loading'}
        {...studioElementActions(props, client ? 'client' : 'designer')}
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
