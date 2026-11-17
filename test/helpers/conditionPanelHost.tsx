// The Navigator and the Settings tab's Condition section, small enough for a test page: the real tree
// (StructureTree.tsx NodeList inside the panel's own .structure-tree box) and the real CondPanel, under the
// app's own stylesheets. The test that bundles it (test/electron/props/conditionPanels.test.js) parses the
// Lumos fixture in Node and hands the nodes in as `window.conditionHostInput`; this page validates them with
// the shared page-node parser, draws them, and says, in `window.conditionHost`, the box of each selected row
// and of the tinted block under it.
import { createRoot } from 'react-dom/client';
import { NodeList, type StructureTreeContext } from '../../src/features/structure/StructureTree';
import { CondPanel } from '../../src/features/props/SourcePanels';
import { parsePageNode, type PageNode } from '../../shared/page/pageNode';
import type { SchemaField } from '../../src/editor/dataScope';
import '../../src/features/props/conditionalValue.css';

interface Tree {
  readonly name: string;
  readonly nodes: readonly PageNode[];
  readonly selectedId: string;
}

interface Panel {
  readonly name: string;
  readonly node: Extract<PageNode, { readonly kind: 'cond' }>;
}

interface Box {
  readonly left: number;
  readonly right: number;
}

const input: unknown = Reflect.get(window, 'conditionHostInput');
const record = (value: unknown, what: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Assertion failed: ${what} is an object`);
  }
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Assertion failed: ${what} is a list`);
  }
  return value;
};
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Assertion failed: ${what} is text`);
  }
  return value;
};

const given = record(input, 'the host input');
const trees: readonly Tree[] = list(given['trees'], 'trees').map((entry) => {
  const tree = record(entry, 'a tree');
  return {
    name: text(tree['name'], 'a tree name'),
    nodes: list(tree['nodes'], 'tree nodes').map((node) => parsePageNode(node)),
    selectedId: text(tree['selectedId'], 'a selected id'),
  };
});
const panels: readonly Panel[] = list(given['panels'], 'panels').map((entry) => {
  const panel = record(entry, 'a panel');
  const node = parsePageNode(panel['node']);
  if (node.kind !== 'cond') {
    throw new Error('Assertion failed: a panel shows an if');
  }
  return { name: text(panel['name'], 'a panel name'), node };
});
const context = record(given['context'], 'the context');
const schema: readonly SchemaField[] = list(context['propsSchema'], 'the schema').map((entry) => {
  const field = record(entry, 'a schema field');
  const options = field['options'] === undefined ? [] : list(field['options'], 'options').map((option) => text(option, 'an option'));
  return { name: text(field['name'], 'a field name'), type: text(field['type'], 'a field type'), options };
});
const bindContext = { frontmatter: text(context['frontmatter'], 'the frontmatter'), propsSchema: schema };

function treeContext(selectedId: string): StructureTreeContext {
  return {
    canEdit: () => true,
    selectedId,
    currentLayoutName: '',
    dropTarget: undefined,
    setDropTarget: () => {},
    isCollapsed: () => false,
    isDndPayload: () => false,
    performDrop: () => {},
    placementFor: () => ({ kind: 'open' }),
    noteDrop: () => {},
    nodeById: () => undefined,
    onSelect: () => {},
    toggleCollapse: () => {},
    openContextMenu: () => {},
  };
}

const nothing = (): void => {};

function Page() {
  return (
    <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start', flexWrap: 'wrap', background: 'var(--bg)' }}>
      {trees.map((tree) => (
        <div key={tree.name} data-tree={tree.name} className="panel-section grow navigator" style={{ width: 260, height: 300, flex: 'none' }}>
          <div className="panel-body" style={{ overflow: 'auto', height: '100%', scrollbarGutter: 'stable' }}>
            <div className="structure-tree">
              <NodeList nodes={tree.nodes} parentId={undefined} depth={0} {...treeContext(tree.selectedId)} />
            </div>
          </div>
        </div>
      ))}
      {panels.map((panel) => (
        <div
          key={panel.name}
          data-panel={panel.name}
          className="props-panel"
          style={{ width: 300, flex: 'none', background: 'var(--bg-panel, var(--bg))', padding: 8 }}
        >
          <CondPanel
            node={panel.node}
            bindContext={bindContext}
            onSetText={nothing}
            onToggleElse={nothing}
            onSetProp={nothing}
            onRenameProp={nothing}
            onSetContent={nothing}
            onSetInline={nothing}
          />
        </div>
      ))}
    </div>
  );
}

const rootElement = document.querySelector('#root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Assertion failed: the host page holds a root');
}
createRoot(rootElement).render(<Page />);

const boxOf = (target: Element | undefined): Box | undefined => {
  const rect = target?.getBoundingClientRect();
  return rect === undefined ? undefined : { left: rect.left, right: rect.right };
};

// The selected row and the block under it, per tree, once drawn.
function measure(): Readonly<Record<string, { readonly row: Box | undefined; readonly block: Box | undefined }>> {
  const out: Record<string, { readonly row: Box | undefined; readonly block: Box | undefined }> = {};
  for (const element of document.querySelectorAll<HTMLElement>('[data-tree]')) {
    out[element.dataset['tree'] ?? ''] = {
      row: boxOf(element.querySelector('.structure-node.selected') ?? undefined),
      block: boxOf(element.querySelector('.structure-subtree') ?? undefined),
    };
  }
  return out;
}
Reflect.set(window, 'conditionHost', { measure });
