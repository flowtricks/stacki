// The shapes the binding fields share: where a field is, the data it can
// read, a value change, the insert api, a picked chip, and each field's props
// (propBindings.tsx).

import type { MutableRefObject, RefObject } from 'react';
import type { Completion } from '@codemirror/autocomplete';
import type { Attr } from '../../../shared/page/pageNode';
import type { FieldDefinition } from './propRules';
import type { TemplateHole } from '../../editor/bindings';
import type { RichContext } from './RichContent';
import type { ChipsOf } from '../../ui/ExprInput';
import type { PickerNode } from './DataPicker';
import type { NewPropSeed } from './newPropModel';
import type { PropDeclaration } from '../../editor/propDeclaration';
import type { VariableRename } from '../../../shared/engine/variableRename';
import type { FieldFocus } from './fieldFocus';

export interface FieldPosition {
  readonly left: number;
  readonly top: number;
  readonly width?: number;
}
/** Where a field's dot opened its picker, and whether the caret was in the field then. */
export interface FieldPickerAt extends FieldPosition {
  readonly focus: FieldFocus;
}
export interface SourceContext {
  readonly frontmatter?: string | undefined;
  readonly imports?: unknown;
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
  readonly onSetFrontmatter?: ((source: string) => void) | undefined;
  /** Renames a frontmatter variable across the file; a message says why it was refused. */
  readonly onRenameVariable?: ((rename: VariableRename) => string | undefined) | undefined;
  readonly onOpenSymbol?: ((name: string) => void) | undefined;
}
export type ValueChange = (value: Attr | undefined, immediate?: boolean) => void;
export interface InsertAPI {
  readonly insert: (path: string) => void;
}
export type Chip = Element | TemplateHole;
export interface ChipPick {
  readonly chip: TemplateHole | undefined;
  readonly pos: FieldPosition;
  /** Whether the caret was in the field when its dot opened the picker; unfocused for a chip's own press. */
  readonly focus: FieldFocus;
}
export interface BindingContextProps {
  readonly bindContext?: RichContext | undefined;
  readonly dataContext?: SourceContext | undefined;
}
export interface SourceEditButtonProps {
  readonly name: string;
  readonly dataContext?: SourceContext | undefined;
  readonly anchorRef?: RefObject<HTMLElement>;
  readonly className?: string;
}
export interface ExprValueFieldProps extends BindingContextProps {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly onChange: ValueChange;
}
export interface ConditionFieldProps extends BindingContextProps {
  readonly test: string;
  readonly scope: readonly Completion[];
  readonly chipsOf: ChipsOf;
  readonly onSetText: (value: string) => void;
}
export interface ExpressionBindingFieldProps extends BindingContextProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}
export interface BindHandleProps {
  readonly active: boolean;
  /** `host` is the field the dot belongs to; `focus` says whether the caret was in it when the dot was pressed (fieldFocus.ts). */
  readonly onOpen: (host: Element | undefined, focus: FieldFocus) => void;
}
export interface FieldDataPickerProps extends BindingContextProps {
  readonly pos: FieldPosition;
  readonly current?: string | undefined;
  readonly tree?: readonly PickerNode[] | undefined;
  /** The field the picker is for: in a component, its props are fitted to it and a new one can be made for it. */
  readonly seed?: NewPropSeed | undefined;
  readonly onPick: (path: string) => void;
  /** Binds the whole field to a prop just made for it; picking inserts at the caret instead. */
  readonly onBindNew?: ((path: string, declaration: PropDeclaration) => void) | undefined;
  readonly onWrite?: (() => void) | undefined;
  /** Offers "Create conditional" in a component, which opens the field's Value conditions editor. Absent, the row is not drawn. */
  readonly onConditional?: (() => void) | undefined;
  readonly onClose: () => void;
}
export interface BindFieldProps extends BindingContextProps {
  readonly value?: Attr | undefined;
  readonly field?: FieldDefinition;
  readonly placeholder?: string | undefined;
  readonly wrapCode?: boolean;
  readonly apiRef?: MutableRefObject<InsertAPI | undefined>;
  readonly onChange: ValueChange;
}
export interface ValueCodeEditorProps extends BindingContextProps {
  readonly pos: FieldPosition;
  readonly name: string;
  readonly value: string;
  readonly scope: readonly Completion[];
  readonly chipsOf: ChipsOf;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
}
export interface VarSourceEditorProps {
  readonly pos: FieldPosition;
  readonly name: string;
  readonly code: string;
  readonly onChangeCode?: ((source: string) => void) | undefined;
  /** Where a new name for the variable goes, so every read of it follows. */
  readonly onRename?: ((rename: VariableRename) => string | undefined) | undefined;
  /** The open file whose frontmatter this is. */
  readonly filePath?: string | undefined;
  readonly onClose: () => void;
}
