import { isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { VariantPreview } from './VariantPreview';
import { LockedSettings } from './LockedSettings';
import { slotOptions } from './slotOptions';
import { useBindContext } from './bindContext';
import PropsPanel from '../../../vendor/stacki/src/features/props/PropsPanel';
import { useEditorRole } from '../roles/useEditorRole';
import { parsePageNode } from '../../../vendor/stacki/shared/page/pageNode';
import { type PropsPanelProps } from '../../../vendor/stacki/src/features/props/propsPanelTypes';
import { applyEdits, contentEdit, flatten, nodeAt, type ParserNode } from '../source/source';
import { routeFor, type Project, type Component } from '../project/projectClient';
import type { SharedDocument } from '../collaboration/useDocument';
import {
  assetProp,
  frontmatterEdit,
  inlineContentEdit,
  nodeTextEdit,
  renameTag,
  setAttributes,
} from './settingsEdits';

interface Props {
  readonly document: SharedDocument;
  readonly selected: string;
  readonly node: ParserNode | undefined;
  readonly nodes: readonly ParserNode[];
  readonly component: Component | undefined;
  readonly project: Project;
  readonly openCode?: () => void;
  readonly error: (error: unknown) => void;
}
export function Settings(props: Props) {
  const client = useEditorRole() === 'client';
  const { document, node, selected, component, project, nodes } = props;
  const source = document.text.toString();
  const current = settingsNode(selected, node);
  const bindContext = useBindContext(document.file, source, nodes, selected);
  const change = (edit: (source: string) => string) => {
    try {
      document.replaceSource(edit(document.text.toString()));
    } catch (error) {
      props.error(error);
    }
  };
  const handlers = settingsHandlers(props, change);
  const notice = document.selectionNotice;
  if (notice) {
    return <LockedSettings notice={notice} report={props.error} />;
  }
  return (
    <VariantPreview
      file={document.file}
      node={selected}
      component={component?.file}
      source={source}
    >
      <PropsPanel
        valuePolicy={isDefaultsCanvas(document.file) ? 'defaults' : 'instance'}
        node={
          client && !['element', 'component', 'text'].includes(current?.kind ?? '')
            ? undefined
            : current
        }
        schema={component?.fields ?? []}
        isLayout={node?.id === 'layout'}
        currentLayoutName={node?.name ?? ''}
        takesSlotText={component?.slots.includes('default') ?? false}
        slotOptions={slotOptions(project, document.file, source, selected)}
        allowAttrs={node?.kind === 'element'}
        projectClasses={project.classes}
        bindContext={bindContext}
        projectPath="studio"
        filePath={document.file}
        frontmatterSource={/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ''}
        linkContext={{
          pages: project.pages.map((file) => ({
            name: file.replace('src/pages/', ''),
            route: routeFor(file),
          })),
          sectionIds: flatten(nodes).flatMap((node) =>
            node.props?.['id']?.type === 'string' ? [node.props['id'].value] : [],
          ),
          projectPath: 'studio',
        }}
        onSetAssetProp={(id, name, picked) =>
          change((source) => assetProp(source, id, document.file, name, picked.rel))
        }
        {...(props.openCode && !client ? { onOpenCode: props.openCode } : {})}
        {...(client
          ? {}
          : {
              onSetFrontmatter: (value: string) =>
                change((source) => applyEdits(source, [frontmatterEdit(source, value)])),
            })}
        {...handlers}
      />
    </VariantPreview>
  );
}
function settingsHandlers(
  props: Props,
  change: (edit: (source: string) => string) => void,
): Pick<
  PropsPanelProps,
  | 'onSetProp'
  | 'onSetProps'
  | 'onRenameProp'
  | 'onSetText'
  | 'onSetContent'
  | 'onSetInline'
  | 'onChangeTag'
> {
  const id = props.selected;
  return {
    onSetProp: (name, value) => change((source) => setAttributes(source, id, { [name]: value })),
    onSetProps: (id, values) => change((source) => setAttributes(source, id, values)),
    onRenameProp: (previous, next) =>
      change((source) => {
        const value = nodeAt(source, id).props?.[previous];
        return setAttributes(source, id, { [previous]: undefined, [next]: value });
      }),
    onSetContent: (value) =>
      change((source) => applyEdits(source, [contentEdit(source, id, value)])),
    onSetText: (value, renames) =>
      change((source) => {
        if (renames?.some((rename) => rename.from !== rename.to)) {
          throw new Error('Rename loop bindings and their references together in Code.');
        }
        return applyEdits(source, [nodeTextEdit(source, id, value)]);
      }),
    onSetInline: (nodes) =>
      change((source) => applyEdits(source, [inlineContentEdit(source, id, nodes)])),
    onChangeTag: (name) => change((source) => renameTag(source, id, name)),
  };
}

function settingsNode(selected: string, node: ParserNode | undefined) {
  if (selected === 'frontmatter') {
    return { kind: 'frontmatter' as const, id: selected };
  }
  return node ? parsePageNode(node) : undefined;
}
