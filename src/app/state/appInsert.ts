// Inserting for Stacki Apps (`node.insert`, src/app/shell/desktopAppHost.ts): the
// insert palette's node and placement rule, plus what an app may ask beyond a
// palette pick — attributes or props on the new node, a place of its own, and a
// node to replace. Each insert is one gesture (appInsertGesture.ts), so it is one
// undo step and one save, a replaced node's removal and the imports included.

// i18n-ignore-file: refusals returned to the app that asked for the insert (read by apps and agents), not text a person reads.
import { useCallback } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppInsert, AppInsertOutcome, AppInsertPlace } from '../../../shared/properties/appsRpc';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { anchoredInsertTarget, insertTargetFor, type InsertTarget } from '../../editor/insertTarget';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { findImportPath } from '../../ipc/appBridge';
import { canAddComponent } from '../../features/palette/componentVisibility';
import { currentRole } from '../../lib/currentRole';
import { appInsertGesture, withStringProps } from '../model/appInsertGesture';
import { componentInstancePlacement, loadComponentInstance, resolveInstanceImports } from '../model/componentInstances';
import { sayMissingAssets } from './missingDefaultAssets';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { newId } from '../model/nodeFactory';
import { insertedNode } from '../model/pageGestures';
import { gatePlacement } from '../model/placementGate';
import { documentOfPath, placementNodeOf } from '../../editor/placementCheck';
import type { ImportDecl } from '../../../shared/page/pageNode';
import type { useCoreState } from './appLifecycle';
import type { useHistory } from './appNodeEdits';

/** One app insert, as the host hands it over. */
export interface AppInsertRequest {
  readonly item: AppInsert;
  readonly place: AppInsertPlace;
}

const REFUSED_EDIT = 'The page did not take the edit; try again once it has saved';

export function useAppInsert(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { insertables, pageStateRef, projectRef, selectedIdRef, setSelectedId } = coreState;
  const { commitEdit } = history;
  const translate = useTranslate();

  const insertForApp = useCallback(
    async (request: AppInsertRequest): Promise<AppInsertOutcome> => {
      const { item, place } = request;
      const pagePath = pageStateRef.current.currentPage?.path;
      if (pagePath === undefined || pageStateRef.current.pageState?.editable !== true) {
        return { applied: false, reason: 'The open page cannot be edited' };
      }
      // A component's starting markup and imports are read from disk before the page is looked at again.
      let prepared: { readonly node: EditorNode; readonly imports: readonly ImportDecl[] | undefined } | undefined = undefined;
      let component: ScanComponent | undefined = undefined;
      if (item.kind === 'component') {
        component = insertables.find((entry) => entry.name === item.name);
        const projectPath = projectRef.current?.path;
        if (component === undefined || projectPath === undefined) {
          return { applied: false, reason: `This project has no component named ${item.name}` };
        }
        if (!canAddComponent(currentRole(), component)) {
          return { applied: false, reason: `The current role cannot add ${item.name}` };
        }
        const instance = await loadComponentInstance(component, insertables, projectPath);
        const resolved = await resolveInstanceImports(instance, projectPath, (target) => findImportPath(projectPath, pagePath, target));
        // Never apply a pending insert to a page or project opened while those reads ran.
        if (pageStateRef.current.currentPage?.path !== pagePath || projectRef.current?.path !== projectPath) {
          return { applied: false, reason: 'The open page changed before the component was inserted' };
        }
        const state = pageStateRef.current.pageState;
        if (state?.editable !== true) {
          return { applied: false, reason: 'The open page cannot be edited' };
        }
        const placed = componentInstancePlacement(state.model, instance, resolved);
        const imports = placed.imports.length === state.model.imports.length ? undefined : placed.imports;
        sayMissingAssets(instance.missing, translate);
        prepared = { node: withStringProps(placed.node, item.props), imports };
      }
      const state = pageStateRef.current.pageState;
      if (state?.editable !== true) {
        return { applied: false, reason: 'The open page cannot be edited' };
      }
      if (item.kind === 'element') {
        const node = insertedNode({ type: 'element', tag: item.tag }, newId());
        assert(node !== undefined, 'An element always makes a node');
        prepared = { node: withStringProps(node, item.attributes), imports: undefined };
      }
      assert(prepared !== undefined, 'Every insert kind prepares its node');
      const paletteItem = item.kind === 'element' ? { type: 'element', tag: item.tag } : { type: 'component', name: item.name };
      const target = appInsertTarget(state.model, place, selectedIdRef.current, paletteItem, insertables);
      if (target.kind === 'refused') {
        return { applied: false, reason: target.reason };
      }
      // The place an app names is never moved: the one placement rule either takes it or says no.
      const pagePlace = { insertables, pagePath };
      const gate = gatePlacement(
        state.model,
        { kind: 'new', node: placementNodeOf(prepared.node, { insertables, document: documentOfPath(pagePath) }, 'deep') },
        target.target,
        pagePlace,
      );
      const refused = gate.kind === 'stop' ? gate.refusal : gate.moved;
      if (refused !== undefined) {
        return { applied: false, reason: `The place cannot take that node (${refused.reason})` };
      }
      const replacedId = place.kind === 'replace' ? place.nodeId : undefined;
      const committed = commitEdit(appInsertGesture(state.model, { node: prepared.node, place: target.target, replacedId, imports: prepared.imports }));
      if (!committed) {
        return { applied: false, reason: REFUSED_EDIT };
      }
      // The palette's own follow-up: the new node is selected, under the id the gesture gave it.
      setSelectedId(prepared.node.id);
      return { applied: true, nodeId: prepared.node.id };
    },
    [commitEdit, insertables, pageStateRef, projectRef, selectedIdRef, setSelectedId, translate],
  );
  return { insertForApp };
}

// Where the node goes: where the palette would put it for the selection, or the place the app named.
function appInsertTarget(
  model: EditorModel,
  place: AppInsertPlace,
  selectedId: string | undefined,
  item: { readonly type: string; readonly tag?: string; readonly name?: string },
  insertables: readonly ScanComponent[],
): { readonly kind: 'placed'; readonly target: InsertTarget } | { readonly kind: 'refused'; readonly reason: string } {
  switch (place.kind) {
    case 'selection':
      return { kind: 'placed', target: insertTargetFor(model, selectedId, item, insertables) };
    case 'before':
    case 'after':
      return anchoredInsertTarget(model, { position: place.kind, anchorId: place.anchor, index: undefined }, item, insertables);
    case 'inside':
      return anchoredInsertTarget(model, { position: 'inside', anchorId: place.anchor, index: place.index }, item, insertables);
    case 'replace':
      return anchoredInsertTarget(model, { position: 'replace', anchorId: place.nodeId, index: undefined }, item, insertables);
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}
