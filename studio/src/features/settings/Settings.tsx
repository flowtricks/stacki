import { useMemo, useRef } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { ImportNeed } from '../../../vendor/stacki/src/editor/dataSample';
import { collectionQueryEdit, dataImportEdit, type AddedSource } from './frontmatterAdditionEdit';
import { isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { VariantPreview } from './VariantPreview';
import { LockedSettings } from './LockedSettings';
import { slotOptions } from './slotOptions';
import { useBindContext } from './bindContext';
import PropsPanel from '../../../vendor/stacki/src/features/props/PropsPanel';
import { useEditorRole } from '../roles/useEditorRole';
import { parsePageModel, parsePageNode, type ImportDecl } from '../../../vendor/stacki/shared/page/pageNode';
import { type PropsPanelProps } from '../../../vendor/stacki/src/features/props/propsPanelTypes';
import { applyEdits, contentEdit, flatten, parsePage, type ParserNode } from '../source/source';
import type { Project, Component } from '../project/projectClient';
import { projectPages } from '../project/pageLabels';
import type { SharedDocument } from '../collaboration/useDocument';
import { assetProp, frontmatterEdit, inlineContentEdit, nodeTextEdit } from './settingsEdits';
import { renameAttribute, takesAttributes, writeAttributes } from './attributeEdit';
import { DescribedError } from '../../../vendor/stacki/shared/properties/describedError';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { loopSourceEdit } from './loopSourceEdit';
import { commentEdits, commentFieldValue } from './commentEdit';
import { useStructureSettings } from './useStructureSettings';

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
  const structure = useStructureSettings({ document, selected, component, project, source, error: props.error });
  // On a component's own file, the binding picker can connect to its props and make new ones (Desktop's newPropHostOf).
  const scope = useBindContext(document.file, source, nodes, selected);
  const page = useMemo(() => loopPage(source), [source]);
  // What a pick writes before it binds (a collection's query, a data file's
  // import) is held for the field's own change and applied first in it, so
  // the page changes once: one undo step, as Desktop's holdForNextEdit.
  const held = useRef<((text: string) => string) | undefined>(undefined);
  const change = (edit: (source: string) => string) => {
    const addition = held.current;
    held.current = undefined;
    try {
      const text = document.text.toString();
      document.replaceSource(edit(addition === undefined ? text : addition(text)));
    } catch (error) {
      props.error(error);
    }
  };
  const additions = client ? undefined : frontmatterAdditions(document, held, change, props.error);
  // Client mode edits content, never a page's frontmatter: it binds to what is in scope only.
  const bindContext = {
    ...scope,
    ...(additions === undefined ? { collections: [], projectSources: [] } : additions),
    newProp: structure.newProp,
  };
  const handlers = settingsHandlers(props, change);
  const notice = document.selectionNotice;
  if (notice) {
    return <LockedSettings notice={notice} report={props.error} />;
  }
  return (
    <VariantPreview file={document.file} node={selected} component={component?.file} source={source}>
      <PropsPanel
        valuePolicy={isDefaultsCanvas(document.file) ? 'defaults' : 'instance'}
        node={client && !['element', 'component', 'text'].includes(current?.kind ?? '') ? undefined : current}
        schema={component?.fields ?? []}
        isLayout={node?.id === 'layout'}
        currentLayoutName={node?.name ?? ''}
        takesSlotText={component?.slots.includes('default') ?? false}
        slotOptions={slotOptions(project, document.file, source, selected)}
        allowAttrs={takesAttributes(current, component)}
        projectClasses={project.classes}
        bindContext={bindContext}
        loopContext={{ ...bindContext, frontmatter: page.frontmatter }}
        frontmatterImports={page.imports}
        projectPath="studio"
        filePath={document.file}
        frontmatterSource={/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ''}
        linkContext={{
          pages: projectPages(project),
          sectionIds: flatten(nodes).flatMap((node) => (node.props?.['id']?.type === 'string' ? [node.props['id'].value] : [])),
          projectPath: 'studio',
        }}
        // `also` (an app pick's alt text) goes in the same source change, so one undo step.
        onSetAssetProp={(id, name, picked, _reference, also) =>
          change((source) => {
            const withAsset = assetProp(source, id, document.file, name, picked.rel);
            return also === undefined ? withAsset : writeAttributes(withAsset, id, also);
          })
        }
        {...(props.openCode && !client ? { onOpenCode: props.openCode } : {})}
        {...(client
          ? {}
          : {
              onSetFrontmatter: (value: string) => change((source) => applyEdits(source, [frontmatterEdit(source, value)])),
              onSetLoopSource: loopSourceHandler(props, change),
            })}
        {...handlers}
        {...structure.handlers}
      />
    </VariantPreview>
  );
}
// The picker's ensureQuery and ensureImport: each answers with the name the
// binding reads now and holds the frontmatter change for the field's edit. A
// field that makes no edit leaves it to go in alone once the click is done.
function frontmatterAdditions(
  document: SharedDocument,
  held: { current: ((text: string) => string) | undefined },
  change: (edit: (source: string) => string) => void,
  report: (error: unknown) => void,
): { readonly ensureQuery: (collection: string) => string | undefined; readonly ensureImport: (need: ImportNeed) => string | undefined } {
  const hold = (addition: (text: string) => string): void => {
    assert(held.current === undefined, 'One frontmatter addition is held at a time');
    held.current = addition;
    window.setTimeout(() => {
      if (held.current === addition) {
        change((text) => text);
      }
    }, 0);
  };
  const ensure = (write: (text: string) => AddedSource): string | undefined => {
    try {
      const text = document.text.toString();
      const now = write(text);
      if (now.source !== text) {
        hold((later) => write(later).source);
      }
      return now.name;
    } catch (error) {
      report(error);
      return undefined;
    }
  };
  return {
    ensureQuery: (collection) => ensure((text) => collectionQueryEdit(text, collection)),
    ensureImport: (need) => ensure((text) => dataImportEdit(text, need)),
  };
}

function settingsHandlers(
  props: Props,
  change: (edit: (source: string) => string) => void,
): Pick<PropsPanelProps, 'comment' | 'onSetComment' | 'onSetProp' | 'onSetProps' | 'onRenameProp' | 'onSetText' | 'onSetContent' | 'onSetInline'> {
  const id = props.selected;
  const labelled = props.node?.kind === 'element' || props.node?.kind === 'component';
  return {
    // The label the Navigator shows beside the node, edited as Desktop's field
    // edits it; only an element or a component takes one (shared/page/leadingNote.ts).
    ...(labelled
      ? {
          comment: commentFieldValue(props.document.text.toString(), id),
          onSetComment: (text: string) => change((source) => applyEdits(source, commentEdits(source, id, text))),
        }
      : {}),
    // Attribute and prop writes go through the source planner, as Desktop's do (attributeEdit.ts).
    onSetProp: (name, value) => change((source) => writeAttributes(source, id, { [name]: value })),
    onSetProps: (id, values) => change((source) => writeAttributes(source, id, values)),
    onRenameProp: (previous, next) => change((source) => renameAttribute(source, id, previous, next)),
    onSetContent: (value) => change((source) => applyEdits(source, [contentEdit(source, id, value)])),
    onSetText: (value, renames) =>
      change((source) => {
        if (renames?.some((rename) => rename.from !== rename.to)) {
          throw new DescribedError(described('settings.element.renameLoop'));
        }
        return applyEdits(source, [nodeTextEdit(source, id, value)]);
      }),
    onSetInline: (nodes) => change((source) => applyEdits(source, [inlineContentEdit(source, id, nodes)])),
  };
}

// The loop settings Desktop shows (LoopSettings.tsx), written through the same
// plan Desktop writes them with (loopSourceEdit.ts). A List property made from
// the Source menu needs the component's props written first, which only Code
// does here, so that one choice is answered with where to do it.
function loopSourceHandler(props: Props, change: (edit: (source: string) => string) => void): NonNullable<PropsPanelProps['onSetLoopSource']> {
  return (target, sanityClient, declaration) => {
    if (declaration !== undefined) {
      return { ok: false, ...described('settings.element.loopAddProp') };
    }
    const source = props.document.text.toString();
    const edited = (() => {
      try {
        return loopSourceEdit(source, props.selected, target, sanityClient);
      } catch (error) {
        props.error(error);
        return undefined;
      }
    })();
    if (edited === undefined) {
      return { ok: false, ...described('settings.element.loopFailed') };
    }
    // A refused plan leaves the page as it was: nothing goes to the shared document.
    if (edited.source !== source) {
      change(() => edited.source);
    }
    return edited.result;
  };
}

// What a loop's settings read the page by, as Desktop hands them over: the
// frontmatter without its imports, and the imports as records (getCollection,
// a Sanity client). Without them a loop reads as a value from nowhere, and the
// panel has no Filters, Sort or Limit to show.
function loopPage(source: string): { readonly frontmatter: string; readonly imports: readonly ImportDecl[] } {
  const parsed = parsePage(source);
  if (!parsed.editable) {
    return { frontmatter: '', imports: [] };
  }
  const model = parsePageModel(parsed.model);
  return { frontmatter: model.extraFrontmatter, imports: model.imports };
}

function settingsNode(selected: string, node: ParserNode | undefined) {
  if (selected === 'frontmatter') {
    return { kind: 'frontmatter' as const, id: selected };
  }
  return node ? parsePageNode(node) : undefined;
}
