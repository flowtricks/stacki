import type { PropValuePolicy } from './propValuePolicy';
// The shapes the settings panel is built from: the selected node, the panel's
// props, and the props each kind of node's panel takes (PropsPanel.tsx).

import type { PageNode, PairedNode, ChunkGroupNode, Attr, ValueNode, ImportDecl } from '../../../shared/page/pageNode';
import type { LoopTarget } from '../../editor/loopQueryPlan';
import type { PropDeclaration } from '../../editor/propDeclaration';
import type { ListProp } from '../../editor/listProps';
import type { LoopApplyResult } from './LoopSettings';
import type { FieldDefinition, PropValues } from './propRules';
import type { SetProp, SetProps } from './propAttributes';
import type { Rename, SetText, TagOption, TagFieldProps } from './propNodeEditors';
import type { VariableRename } from '../../../shared/engine/variableRename';
import type { SourceContext } from './propBindings';
import type { RichContext, InlineNode } from './RichContent';
import type { TextPiece } from './textConnect';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { AssetReference, PickedAsset } from '../../ui/AssetField';
import React from 'react';
import type { ComponentEditingControl } from './ComponentEditingFields';
import LinkField from './LinkField';

export type SelectedNode = PageNode | { readonly kind: 'frontmatter'; readonly id: string };
export type ElementNode = (PairedNode | ChunkGroupNode) & { readonly props?: PropValues };
export interface PropsPanelProps {
  readonly valuePolicy?: PropValuePolicy;
  readonly node?: SelectedNode | undefined;
  readonly focusClass?: number;
  readonly focusContent?: number;
  readonly isLayout?: boolean;
  readonly layouts?: readonly TagOption[];
  readonly currentLayoutName?: string;
  readonly onChangeLayout?: (name: string) => void;
  readonly schema?: readonly FieldDefinition[];
  /** Props of the selected component that hold its list's settings (listProps.ts). */
  readonly listProps?: ReadonlyMap<string, ListProp> | undefined;
  readonly slotOptions?: readonly string[] | undefined;
  readonly takesSlotText?: boolean;
  readonly tagOptions?: readonly TagOption[];
  readonly projectClasses?: readonly string[];
  readonly allowAttrs?: boolean;
  /** For an instance: the tag its component types passed attributes by (`Props extends HTMLAttributes<"img">`). */
  readonly attributesTag?: string | undefined;
  readonly comment?: string;
  readonly onSetComment?: (value: string) => void;
  readonly loopContext?: RichContext | undefined;
  readonly bindContext?: RichContext | undefined;
  readonly linkContext?: React.ComponentProps<typeof LinkField>['context'] | undefined;
  readonly onSetProp: SetProp;
  readonly onSetProps?: SetProps;
  /** Writes an element's whole attribute list in a new order: an attributes prop's spread and the defaults before it. */
  readonly onReplaceProps?: ((nodeId: string, props: Readonly<Record<string, Attr>>) => void) | undefined;
  /** `also` are props written in the same edit (one undo step): the alt text an app's pick came with. */
  readonly onSetAssetProp?: (nodeId: string, name: string, picked: PickedAsset, reference: AssetReference, also?: PropValues) => void;
  readonly onRenameProp: (previous: string, next: string) => void;
  readonly onChangeTag?: TagFieldProps['onChangeTag'];
  readonly onSetText: SetText;
  readonly onSetContent: (text: string) => void;
  readonly onSetInline: (nodes: readonly InlineNode[]) => void;
  /**
   * The selected component instance's text is rich text (its component's richText setting, while it qualifies): the
   * Content field becomes the rich text editor's button and a code view (ComponentEditingFields.tsx).
   */
  readonly richTextContent?: boolean | undefined;
  /** With rich text on a component that takes its HTML through a prop (`set:html={html}`) and no slot: that prop. */
  readonly richTextProp?: string | undefined;
  /** Writes the selected node's content as code, byte for byte; absent where the host has no source writer. */
  readonly onSetContentSource?: ((source: string) => void) | undefined;
  /** The selected node's content as the file holds it (the bytes between its tags); undefined when it cannot be read. */
  readonly contentSource?: string | undefined;
  /** While the selected node is the component whose defaults are being set: its editing settings, last in Settings. */
  readonly componentEditing?: ComponentEditingControl | undefined;
  /** Restates the selected text or expression node as these pieces (TextConnectField.tsx); absent where the host cannot. */
  readonly onSetTextPieces?: ((pieces: readonly TextPiece[]) => void) | undefined;
  readonly onOpenCode?: () => void;
  readonly onSetFrontmatter?: (source: string) => void;
  readonly frontmatterSource?: string;
  /** The open file's imports: what a loop's source is read against. */
  readonly frontmatterImports?: readonly ImportDecl[] | undefined;
  /** Points the loop at a list; with a declaration, declares that List property first, in the same undo step. */
  /** A loop's Code row: writes the head, renaming a variable when that is what it says; a message says why it was refused. */
  readonly onCommitLoopHead?: ((value: string, renames: readonly Rename[]) => string | undefined) | undefined;
  /** Renames a frontmatter variable across the file; a message says why it was refused. */
  readonly onRenameVariable?: ((rename: VariableRename) => string | undefined) | undefined;
  readonly onSetLoopSource?: (target: LoopTarget, sanityClient: 'available' | 'unavailable', declaration?: PropDeclaration) => LoopApplyResult;
  /** Renames a list setting's property, or changes its tooltip; resolves with why it could not. */
  readonly onEditLoopProperty?: (key: string, edit: { readonly name: string; readonly description: string }) => Promise<string | undefined>;
  readonly onOpenSymbol?: (name: string) => void;
  readonly onToggleElse?: (value: boolean) => void;
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
}
export type NodePanelProps<Kind extends SelectedNode['kind']> = Omit<PropsPanelProps, 'node'> & {
  readonly node: Extract<SelectedNode, { readonly kind: Kind }> | (Kind extends ValueNode['kind'] ? ValueNode : never);
};
export interface ElementPropsPanelProps extends Omit<PropsPanelProps, 'node'> {
  readonly node: ElementNode;
  readonly dataContext: SourceContext;
  readonly stashRef: React.MutableRefObject<Map<string, PropValues>>;
}
export interface SourceDimensionsOptions {
  readonly source: Attr | undefined;
  readonly projectPath: string | undefined;
  readonly filePath: string | undefined;
  readonly imports: unknown;
  readonly setSourceDimensions: (value: AssetDimensions) => void;
}
