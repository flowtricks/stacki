import Popup from '../../ui/Popup';
import { dataPickerPosition } from './dataPickerPosition';
import { useEffect, useRef, useState } from 'react';
import { useCodeAccess, ManagedValue } from '../../ui/CodeAccess';
import type { BindInputHandle } from './BindInput';
import type { ExprInputAPI } from '../../ui/ExprInput';
import type { PickerNode } from './DataPicker';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { definedFields } from '../../../shared/core/boundary';
import { dataTree, scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import { partsFromValue, resolvePick, templateHoles, valueFromParts, valueModeOf } from '../../editor/bindings';
import BindInput from './BindInput';
import DataPicker from './DataPicker';
import ExprInput from '../../ui/ExprInput';
import { type FieldPosition, type Chip, type BindFieldProps } from './bindingTypes';
import { referencedName, symbolTarget, VarSourceEditor } from './BindingEditors';
export {
  referencedName,
  SourceEditButton,
  ExprValueField,
  ConditionField,
  ExpressionBindingField,
  BindHandle,
  FieldDataPicker,
  ValueCodeEditor,
} from './BindingEditors';

export { type FieldPosition, type SourceContext, type ValueChange, type InsertAPI } from './bindingTypes';

function chipExpr(chip: Chip | undefined) {
  if (!chip) {
    return '';
  }
  if ('path' in chip) {
    return chip.path;
  }
  if ('getAttribute' in chip) {
    return chip.getAttribute('data-expr') || '';
  }
  return '';
}

function chipPath(chip: Chip | undefined) {
  if (chip && 'getAttribute' in chip) {
    return chip.getAttribute('data-full') || chip.getAttribute('data-expr') || '';
  }
  return chipExpr(chip);
}

export function BindField(props: BindFieldProps) {
  return useCodeAccess() ? <EditableBindField {...props} /> : <ClientBindField {...props} />;
}
function ClientBindField({ value, onChange, placeholder }: BindFieldProps) {
  if (value && value.type !== 'string') {
    return <ManagedValue />;
  }
  return <input value={value?.value ?? ''} placeholder={placeholder ?? ''} onChange={(event) => onChange({ type: 'string', value: event.target.value })} />;
}
function EditableBindField(props: BindFieldProps) {
  const state = useBindFieldModel(props);
  const actions = useBindFieldActions(state);
  useBindFieldAPI(state);
  return <BindFieldView state={{ ...state, ...actions }} />;
}
function useBindFieldModel(props: BindFieldProps) {
  const { value, field, bindContext } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<BindInputHandle>(null);
  const [menu, setMenu] = useState<(FieldPosition & { readonly chip: Chip | undefined }) | undefined>(undefined);
  // Editing a `const` from this file happens right under the field, the way the
  // pencil used to open it — it is the menu that asks for it now.
  const [source, setSource] = useState<(FieldPosition & { readonly name: string }) | undefined>(undefined);
  // The code editor, so a chip pressed inside it can be repointed in place.
  const exprApiRef = useRef<ExprInputAPI | undefined>(undefined);
  const [raw, setRaw] = useState(false);
  // What the code editor draws as chips: every `${…}` hole naming a path, plus
  // every value in scope the code names outright.
  const scopeNames = new Set(scopeCompletions(bindContext || {}).map((completion) => completion.label.split('.')[0] ?? ''));
  const codeChips = (text: string) => {
    const holes = templateHoles(text);
    const taken = (from: number, to: number) => holes.some((hole) => from < hole.to && to > hole.from);
    return [...holes, ...scopeChips(text, scopeNames).filter((chip) => !taken(chip.from, chip.to))].sort((left, right) => left.from - right.from);
  };
  // Typing must not move the field out from under the caret: an expression
  // half-way to becoming a call reads as code the moment the bracket lands,
  // and swapping in the code editor mid-word would take the text with it.
  const [editing, setEditing] = useState(false);
  const text = value && value.type !== 'bare' ? value.value : '';
  assert(text.length <= LIMITS.attrCharsMax, 'BindField: value limit exceeded');
  const parts = partsFromValue(value ?? undefined);
  assert((parts?.length ?? 0) <= LIMITS.attrCharsMax, 'BindField: parts limit exceeded');
  const expr = value?.type === 'expr' ? String(value.value ?? '').trim() : '';
  // Code no field of chips and text can hold keeps the code editor.
  const showInput = !raw && (parts !== undefined || editing);
  // What the parts mean when they are written back — content, or an
  // expression with data in it. The value decides, so a field never changes
  // the meaning of what it was opened on.
  const mode = valueModeOf(value ?? undefined);
  // Written as an expression rather than as text. Booleans and numbers are the
  // obvious ones — `cols={3}` — and a prop that takes an array or an object is
  // the same thing: typing `["Designer", "Developer"]` into it has to write
  // `options={["Designer", "Developer"]}`, not `options="[\"Designer\", …]"`,
  // which is a string the component then calls .map on. It also cost the field
  // its own editor: a string is text, so the panel showed the array in a plain
  // box with no highlighting, and there was no way to type one that stayed code.
  const numeric = !!(field?.type === 'number' || field?.type === 'boolean' || field?.type === 'code' || (field?.type === 'enum' && field?.numeric));

  return {
    ...props,
    wrapRef,
    inputRef,
    menu,
    setMenu,
    source,
    setSource,
    exprApiRef,
    setRaw,
    codeChips,
    setEditing,
    parts,
    expr,
    showInput,
    mode,
    numeric,
  };
}
type BindingState = ReturnType<typeof useBindFieldModel>;
function useBindFieldActions(state: BindingState) {
  const { menu, wrapRef, setMenu, dataContext, setSource, bindContext, showInput, exprApiRef, onChange, setRaw, inputRef } = state;
  const open = (chip: Chip | undefined) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setMenu({
      ...dataPickerPosition(rect),
      chip: chip || undefined,
    });
  };

  // What the menu's Edit row does, for the chip it was opened on. Null when the
  // menu wasn't opened on a chip, or when nothing in reach defines that name —
  // and then the row isn't drawn at all, rather than drawn and inert.
  const editName = referencedName(chipExpr(menu?.chip));
  const editTarget = symbolTarget(editName, dataContext);
  const editChip = () => {
    setMenu(undefined);
    if (editTarget === 'file') {
      dataContext?.onOpenSymbol?.(editName);
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    const width = Math.max(rect?.width ?? 240, 260);
    setSource({
      name: editName,
      top: Math.min((rect?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(rect?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  const pick = (rawPath: string, query: PickerNode['query'] | undefined) => {
    const chip = menu?.chip;
    const path = resolvePick(rawPath, query ?? undefined, bindContext ?? undefined);
    setMenu(undefined);
    if (!showInput) {
      // A hole in the code was pressed: repoint THAT hole and leave the program
      // around it alone. Replacing the whole expression — which is what a pick
      // used to do, since the code editor holds one — would throw away the
      // ternary the hole was written inside.
      if (chip && 'from' in chip) {
        const next = exprApiRef.current?.replaceRange(chip.from, chip.to, `\${${path}}`);
        if (next !== undefined) {
          onChange({ type: 'expr', value: next }, true);
        }
        return;
      }
      // The code editor holds one expression, so a pick replaces it.
      setRaw(false);
      onChange({ type: 'expr', value: path }, true);
      return;
    }
    if (chip && 'getAttribute' in chip) {
      inputRef.current?.replace(chip, path);
    } else {
      inputRef.current?.insert(path);
    }
  };

  return { open, editName, editTarget, editChip, pick };
}

function useBindFieldAPI({ apiRef, showInput, inputRef }: BindingState) {
  // The field's handle inserts through here, so one picker serves both the
  // chip already in the field and the next one. Null while the code editor is
  // up: that holds one expression, so a pick replaces it instead.
  useEffect(() => {
    if (!apiRef) {
      return undefined;
    }
    apiRef.current = showInput ? { insert: (path) => inputRef.current?.insert(path) } : undefined;
    return () => {
      apiRef.current = undefined;
    };
  });
}
type BindingViewState = BindingState & ReturnType<typeof useBindFieldActions>;
function BindFieldMenu({ state }: { readonly state: BindingViewState }) {
  const { menu, bindContext, showInput, expr, pick, editTarget, editChip, editName, setMenu, setRaw } = state;
  return (
    menu && (
      <Popup
        mode="popover"
        portal={false}
        onClose={() => setMenu(undefined)}
        className="dd-popup bind-menu"
        style={{ left: menu.left, top: menu.top, width: menu.width }}
      >
        {/* Built on every render rather than captured when the popup opened:
          stepping to another entry from inside it changes what the data IS,
          and a snapshot would go on showing the entry you stepped away from. */}
        <DataPicker
          tree={dataTree(bindContext || {})}
          current={menu.chip ? chipPath(menu.chip) : showInput ? undefined : expr}
          entries={bindContext?.entryNav ?? undefined}
          {...definedFields({ onStepItem: bindContext?.onStepItem })}
          onPick={pick}
          onExpand={(node, index) => node.query && bindContext?.onNeedSample?.(node.query.collection, index)}
          origin={bindContext?.origin}
          onEdit={editTarget ? editChip : undefined}
          editLabel={editTarget === 'file' ? `Open where ${editName} is defined` : `Edit ${editName}`}
          onWrite={() => {
            setMenu(undefined);
            setRaw(true);
          }}
        />
      </Popup>
    )
  );
}
function BindFieldSource({ state }: { readonly state: BindingState }) {
  const { source, dataContext, setSource } = state;
  return (
    source && (
      <VarSourceEditor
        pos={source}
        name={source.name}
        code={dataContext?.frontmatter || ''}
        onChangeCode={dataContext?.onSetFrontmatter}
        onClose={() => setSource(undefined)}
      />
    )
  );
}
function BindFieldView({ state }: { readonly state: BindingViewState }) {
  const { showInput, wrapRef, inputRef, parts, placeholder, onChange, numeric, field, mode, open, setEditing, expr, exprApiRef, codeChips, wrapCode } = state;
  const list = <BindFieldMenu state={state} />;
  const sourceEditor = <BindFieldSource state={state} />;
  if (showInput) {
    return (
      <div className="prop-expr-row bind-row" ref={wrapRef}>
        <BindInput
          ref={inputRef}
          parts={parts}
          placeholder={placeholder || 'Type, or insert data'}
          // A code prop's parts join as code: text beside a chip is an
          // expression with a value in it, not a sentence with one quoted into
          // it, so `[...items, other]` stays what was typed.
          onChange={(next) => onChange(valueFromParts(next, { numeric, mode: field?.type === 'code' ? 'code' : mode }))}
          onChipClick={(chip) => open(chip)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        />
        {list}
        {sourceEditor}
      </div>
    );
  }

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      {/* Code, with the data in it still shown as data: an expression this
          field can't hold as chips and text — a ternary, a template, a call —
          keeps the editor, and every `${…}` hole naming a plain path is drawn
          as a chip inside it. Pressing one repoints that hole and leaves the
          program around it exactly as written. */}
      <ExprInput
        value={expr}
        syncValue={expr}
        placeholder={placeholder || ''}
        apiRef={exprApiRef}
        // Both kinds of data in one field: a `${…}` hole in a template, and a
        // value named outright — `variantClasses` in a class list is as much a
        // binding as `${post.title}` in a sentence, and only one of them used to
        // look like one.
        chipsOf={codeChips}
        onChipClick={(hit) => open(hit)}
        // Expanded editors keep authored line structure. Compact inline callers
        // can opt into wrapping so the whole value remains readable in the panel.
        wrap={wrapCode ?? false}
        onChange={(draft) => onChange({ type: 'expr', value: draft })}
        onCommit={(committed) => committed !== expr && onChange({ type: 'expr', value: committed }, true)}
      />
      {list}
      {sourceEditor}
    </div>
  );
}
