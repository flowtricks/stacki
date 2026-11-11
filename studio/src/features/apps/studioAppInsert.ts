// Stacki Apps' `node.insert` in Studio (StudioApps.tsx): the place an app asks
// for, worked out on the page's text as the quick insert works out a palette pick
// (QuickInsert.tsx), and the structural action that inserts there. Attributes,
// props and replacing are refused before this runs (appRpcHost.ts): Studio's
// actions insert a bare node, and a removal would be a second history step.

import { assert } from '../../../vendor/stacki/shared/core/assert';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { AppInsert, AppInsertPlace } from '../../../vendor/stacki/shared/properties/appsRpc';
import { HTML_TAGS } from '../../../vendor/stacki/src/editor/elementSchemas';
import { anchoredInsertTarget, insertTargetFor, type InsertTarget } from '../../../vendor/stacki/src/editor/insertTarget';
import { dropTarget } from '../navigator/dropTarget';
import type { Project } from '../project/projectClient';
import { componentImport } from '../source/imports';
import { flatten, parsePage, type TreeAction } from '../source/source';

/** The action an app's insert becomes, or why there is none. */
export type StudioInsertPlan = { readonly kind: 'action'; readonly action: TreeAction } | { readonly kind: 'refused'; readonly reason: string };

/** Plans one insert into the open file's text, for the selection or the place the app named. */
export function planStudioInsert(
  page: { readonly file: string; readonly text: string; readonly selected: string },
  project: Pick<Project, 'components'>,
  insert: { readonly item: AppInsert; readonly place: AppInsertPlace },
): StudioInsertPlan {
  const { item, place } = insert;
  assert(place.kind !== 'replace', 'Studio refuses a replacement before planning it');
  const parsed = parsePage(page.text, { locs: true });
  if (!parsed.editable) {
    return { kind: 'refused', reason: 'The open page cannot be edited' };
  }
  const model = parsePageModel(parsed.model);
  const choice = item.kind === 'element' ? { type: 'element', tag: item.tag } : { type: 'component', name: item.name };
  let location: InsertTarget;
  if (place.kind === 'selection') {
    location = insertTargetFor(model, page.selected, choice, project.components);
  } else {
    const index = place.kind === 'inside' ? place.index : undefined;
    const placed = anchoredInsertTarget(model, { position: place.kind, anchorId: place.anchor, index }, choice, project.components);
    if (placed.kind === 'refused') {
      return placed;
    }
    location = placed.target;
  }
  const target = dropTarget(parsed.model.nodes, location);
  if (item.kind === 'element') {
    // The quick insert's own contract takes HTML's tags: a custom element is Desktop's alone for now.
    if (!HTML_TAGS.includes(item.tag)) {
      return { kind: 'refused', reason: `Studio inserts HTML's own elements; <${item.tag}> works in Stacki Desktop` };
    }
    return { kind: 'action', action: { kind: 'insert-content', ...target, content: { type: 'element', tag: item.tag } } };
  }
  const component = project.components.find((entry) => entry.name === item.name);
  if (component === undefined) {
    return { kind: 'refused', reason: `This project has no component named ${item.name}` };
  }
  return {
    kind: 'action',
    action: {
      kind: 'insert',
      ...target,
      name: component.name,
      importPath: componentImport(page.file, component),
      paired: component.slots.includes('default') && component.slotText === true,
    },
  };
}

/**
 * The id of the node an insert made, read from the page once the server's answer has
 * landed. The server selects what an action inserted for the client that sent it
 * (navigator/actionSelection.ts), so the selection names the new node; it is only
 * trusted when that node is what was asked for, and is otherwise no id at all.
 */
export function insertedNodeId(text: string, selected: string, item: AppInsert): string | undefined {
  if (selected === '' || selected === 'frontmatter') {
    return undefined;
  }
  const parsed = parsePage(text, { locs: true });
  if (!parsed.editable) {
    return undefined;
  }
  const node = flatten(parsed.model.nodes).find((candidate) => candidate.id === selected);
  const kind = item.kind === 'element' ? 'element' : 'component';
  const name = item.kind === 'element' ? item.tag : item.name;
  if (node?.kind === kind && node.name === name) {
    assert(node.id === selected, 'The node found is the one selected');
    return selected;
  }
  return undefined;
}
