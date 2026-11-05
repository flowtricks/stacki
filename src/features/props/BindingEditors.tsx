import { ErrorToast } from '../../ui/ErrorToast';
import { dataPickerPosition } from './dataPickerPosition';
import Popup from '../../ui/Popup';
// The fields and editors a bound prop is edited with: the source button, an
// expression or condition, the bind handle and the data picker, and the code
// editors a value opens — its own code and its variable's source — each
// closing on a press outside (propBindings.tsx).

import { useEffect, useRef, useState } from 'react';
import { useCodeAccess } from '../../ui/CodeAccess';
import type { RefObject } from 'react';
import type { TemplateHole } from '../../editor/bindings';
import type { ExprInputAPI } from '../../ui/ExprInput';
import type { PickerNode } from './DataPicker';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { definedFields } from '../../../shared/core/boundary';
import { dataTree, findDeclaration, findImportOf, scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import { resolvePick } from '../../editor/bindings';
import { checkStatement } from './jsCheck';
import { FIELD_UNFOCUSED, fieldFocusOf, fieldOfHandle, type FieldFocus } from './fieldFocus';
import DataPicker from './DataPicker';
import NewPropForm from './NewPropForm';
// The "New … property" row is drawn here, so its styles load with it.
import './loopSettings.css';
import { boundPath, fittingTree, newPropTitle, type NewPropHost, type NewPropSeed } from './newPropModel';
import ExprInput from '../../ui/ExprInput';
import { CodeIcon, CloseIcon, PencilIcon, PlusIcon } from '../../ui/Icons';
import {
  type FieldPosition,
  type SourceContext,
  type ChipPick,
  type SourceEditButtonProps,
  type ExprValueFieldProps,
  type ConditionFieldProps,
  type ExpressionBindingFieldProps,
  type BindHandleProps,
  type FieldDataPickerProps,
  type ValueCodeEditorProps,
  type VarSourceEditorProps,
} from './bindingTypes';

export function referencedName(expr: unknown) {
  const match = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/);
  return match?.[1] ?? '';
}

export function symbolTarget(name: string, dataContext: SourceContext | undefined) {
  if (!name || !dataContext) {
    return undefined;
  }
  if (dataContext?.onSetFrontmatter && findDeclaration(dataContext?.frontmatter || '', name)) {
    return 'local';
  }
  if (dataContext.onOpenSymbol && findImportOf(dataContext.imports || '', name)) {
    return 'file';
  }
  return undefined;
}

export function SourceEditButton({ name, dataContext, anchorRef, className = 'attr-asset-toggle' }: SourceEditButtonProps) {
  const [position, setPosition] = useState<FieldPosition | undefined>(undefined);
  const target = symbolTarget(name, dataContext);
  const allowCode = useCodeAccess();
  if (!target || !allowCode) {
    return undefined;
  }

  const open = () => {
    if (target === 'file') {
      dataContext?.onOpenSymbol?.(name);
      return;
    }
    const rect = anchorRef?.current?.getBoundingClientRect();
    const width = Math.max(rect?.width ?? 240, 260);
    setPosition({
      top: Math.min((rect?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(rect?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  return (
    <>
      <button
        className={`${className} ${position ? 'on' : ''}`}
        title={target === 'file' ? `Open where ${name} is defined` : `Edit ${name}`}
        onClick={() => (position ? setPosition(undefined) : open())}
      >
        <PencilIcon size={12} />
      </button>
      {position && (
        <VarSourceEditor
          pos={position}
          name={name}
          code={dataContext?.frontmatter || ''}
          onChangeCode={dataContext?.onSetFrontmatter}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

export function ExprValueField({ value, placeholder, dataContext, onChange }: ExprValueFieldProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const name = referencedName(value);

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      <ExprInput
        value={value}
        syncValue={value}
        // Empty when nothing is known, like every other field. The old
        // generic "expression" described the input format, not the fallback,
        // and in a column of placeholders that all name real values it read as
        // if the value itself were the word.
        placeholder={placeholder || ''}
        onChange={(draft) => onChange({ type: 'expr', value: draft })}
        onCommit={(committed) => committed !== value && onChange({ type: 'expr', value: committed }, true)}
      />
      <SourceEditButton name={name} dataContext={dataContext} anchorRef={wrapRef} />
    </div>
  );
}

export function ConditionField({ test, scope, chipsOf, bindContext, onSetText }: ConditionFieldProps) {
  const [pick, setPick] = useState<ChipPick | undefined>(undefined); // {chip, pos}
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);

  const open = (chip: TemplateHole | undefined, focus: FieldFocus) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPick({
      chip: chip || undefined,
      pos: dataPickerPosition(rect),
      focus,
    });
  };

  return (
    <>
      <div className="props-cond-field attr-value-field" ref={wrapRef}>
        <ExprInput
          value={test}
          syncValue={test}
          placeholder="e.g. logo.src"
          completions={scope}
          apiRef={apiRef}
          // The values a condition names, drawn as the same purple chips the rest
          // of the panel shows data in — and pressing one opens the list to swap
          // it, rather than retyping a name inside a boolean.
          chipsOf={chipsOf}
          onChipClick={(chip) => open(chip, FIELD_UNFOCUSED)}
          onCommit={(committed) => committed.trim() && committed !== test && onSetText(committed.trim())}
        />
        {/* And the way a new one gets in: the same purple dot every bindable field
            has — at the caret while the test is being typed, as the whole test otherwise. */}
        <BindHandle active={!!pick} onOpen={(_host, focus) => (pick ? setPick(undefined) : open(undefined, focus))} />
      </div>
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          seed={pick.chip === undefined ? { fit: 'boolean', label: 'Visible', value: '' } : undefined}
          onBindNew={(path) => {
            setPick(undefined);
            onSetText(path);
          }}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            if (chip === undefined && pick.focus.kind === 'unfocused') {
              onSetText(path);
              return;
            }
            const next = chip ? apiRef.current?.replaceRange(chip.from, chip.to, path) : apiRef.current?.insert(path);
            if (next !== undefined) {
              onSetText(next);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </>
  );
}

export function ExpressionBindingField({ value, placeholder, bindContext, onChange }: ExpressionBindingFieldProps) {
  const [pick, setPick] = useState<ChipPick | undefined>(undefined);
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scope = scopeCompletions(bindContext || {});
  const scopeNames = new Set(scope.map((item) => item.label.split('.')[0] ?? ''));
  const chipsOf = (text: string) => scopeChips(text, scopeNames);
  const open = (chip: TemplateHole | undefined, focus: FieldFocus): void => {
    const rectangle = wrapRef.current?.getBoundingClientRect();
    if (!rectangle) {
      return;
    }
    setPick({
      chip,
      pos: dataPickerPosition(rectangle),
      focus,
    });
  };
  return (
    <>
      <div className="property-expression-binding attr-value-field" ref={wrapRef}>
        <ExprInput
          value={value}
          syncValue={value}
          {...definedFields({ placeholder })}
          multiline
          wrap={false}
          completions={scope}
          apiRef={apiRef}
          chipsOf={chipsOf}
          onChipClick={(chip) => open(chip, FIELD_UNFOCUSED)}
          onChange={onChange}
        />
        <BindHandle active={!!pick} onOpen={(_host, focus) => (pick ? setPick(undefined) : open(undefined, focus))} />
      </div>
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            if (chip) {
              apiRef.current?.replaceRange(chip.from, chip.to, path);
            } else if (pick.focus.kind === 'focused') {
              apiRef.current?.insert(path);
            } else {
              // The dot pressed outside the field connects the whole of it.
              onChange(path);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </>
  );
}

export function BindHandle({ active, onOpen }: BindHandleProps) {
  // Read on pointerdown, before the press moves focus anywhere: whether the
  // caret was in this field decides whether a pick replaces the field or lands
  // at the caret (fieldFocus.ts). A click with no pointerdown before it — the
  // keyboard — finds the field as it is then.
  const focusRef = useRef<FieldFocus | undefined>(undefined);
  if (!useCodeAccess()) {
    return undefined;
  }
  return (
    <button
      type="button"
      className={`bind-handle${active ? ' on' : ''}`}
      title="Insert data — a component prop, a CMS field"
      aria-label="Insert data"
      onPointerDown={(event) => {
        focusRef.current = fieldFocusOf(fieldOfHandle(event.currentTarget), event.currentTarget.ownerDocument.activeElement ?? undefined);
      }}
      // The field keeps focus and its caret while the dot is pressed, as a chip's
      // own press does; the picker takes focus once it opens.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        const focus = focusRef.current ?? fieldFocusOf(fieldOfHandle(event.currentTarget), event.currentTarget.ownerDocument.activeElement ?? undefined);
        focusRef.current = undefined;
        onOpen(event.currentTarget.closest('.props-field') ?? undefined, focus);
      }}
    >
      <span className="bind-dot" />
      <PlusIcon size={10} className="bind-plus" />
    </button>
  );
}

export function FieldDataPicker({ pos: position, bindContext, current, tree, seed, onPick, onBindNew, onWrite, onClose }: FieldDataPickerProps) {
  // In a component, the field's own props come first and a new one can be
  // made for it; on a page there is no component to give a prop to, and the
  // picker is as it always was.
  const host = bindContext?.newProp;
  const offer = host !== undefined && seed !== undefined ? { host, seed } : undefined;
  // An imported image picked for a field that takes a URL is read by its `.src`.
  const pick = (path: string, query: PickerNode['query'] | undefined) => {
    const image = offer?.host.imageProps?.get(path);
    const bound = image === undefined ? path : boundPath(path, image, offer?.seed.reference);
    onPick(resolvePick(bound, query ?? undefined, bindContext ?? undefined));
  };
  const [creating, setCreating] = useState(false);
  const fullTree: readonly PickerNode[] = tree || dataTree(bindContext || {});
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={onClose}
      className="dd-popup bind-menu"
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      {offer !== undefined && creating ? (
        <NewPropForm
          host={offer.host}
          seed={offer.seed}
          onCancel={() => setCreating(false)}
          onCreated={(path, declaration) => (onBindNew === undefined ? onPick(path) : onBindNew(path, declaration))}
        />
      ) : (
        <DataPicker
          tree={offer === undefined ? fullTree : fittingTree(fullTree, offer.seed.fit, offer.host.imageProps)}
          current={current ?? undefined}
          entries={bindContext?.entryNav ?? undefined}
          {...definedFields({ onStepItem: bindContext?.onStepItem })}
          onPick={pick}
          onExpand={(node, index) => node.query && bindContext?.onNeedSample?.(node.query.collection, index)}
          origin={bindContext?.origin}
          {...definedFields({ onWrite })}
          footer={!!onWrite}
          lead={offer === undefined ? undefined : <NewPropRow host={offer.host} seed={offer.seed} onOpen={() => setCreating(true)} />}
        />
      )}
    </Popup>
  );
}

// "New Text property": the top row of a component's picker. An attributes
// list can take one rest binding, so a component that has one says so here
// and connects to it below instead.
function NewPropRow({ host, seed, onOpen }: { readonly host: NewPropHost; readonly seed: NewPropSeed; readonly onOpen: () => void }) {
  const blocked = seed.fit === 'attributes' && host.restLocal !== undefined;
  return (
    <>
      <button type="button" className="dp-new-prop" disabled={blocked} onMouseDown={(event) => event.preventDefault()} onClick={onOpen}>
        <PlusIcon size={11} />
        New {newPropTitle(seed.fit)} property
      </button>
      {blocked && <div className="dp-new-prop-reason">A component passes its other attributes on once, as {host.restLocal}.</div>}
    </>
  );
}

export function useValueCodeEditor(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const [pick, setPick] = useState<ChipPick | undefined>(undefined); // {chip, pos}
  useValueCodeEditorDismiss(ref, onClose);
  const open = (chip: TemplateHole | undefined) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // Opened from a chip in the code, which the pick repoints: there is no dot here.
    setPick({
      chip: chip || undefined,
      pos: dataPickerPosition(rect),
      focus: FIELD_UNFOCUSED,
    });
  };
  return { ref, apiRef, pick, setPick, open };
}
export function useValueCodeEditorDismiss(ref: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && !(event.target instanceof window.Node && ref.current.contains(event.target))) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, ref]);
}
export function ValueCodeEditor(props: ValueCodeEditorProps) {
  return useCodeAccess() ? <EditableValueCodeEditor {...props} /> : undefined;
}
function EditableValueCodeEditor({ pos: position, name, value, scope, chipsOf, bindContext, onChange, onClose }: ValueCodeEditorProps) {
  const { ref, apiRef, pick, setPick, open } = useValueCodeEditor(onClose);

  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: position.top, left: position.left, width: position.width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <SourceEditorHeader name={name} onClose={onClose} />
      <ExprInput
        multiline
        autoFocus
        // Code opened to be read keeps its shape: the indentation says what is
        // nested in what, and wrapping every long line throws that away.
        wrap={false}
        className="var-src-code"
        value={value}
        syncValue={value}
        completions={scope}
        apiRef={apiRef}
        chipsOf={chipsOf}
        onChipClick={open}
        onChange={onChange}
      />
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            const next = chip ? apiRef.current?.replaceRange(chip.from, chip.to, path) : apiRef.current?.insert(path);
            if (next !== undefined) {
              onChange(next);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </div>
  );
}

export function VarSourceEditor(props: VarSourceEditorProps) {
  return useCodeAccess() ? <EditableVarSourceEditor {...props} /> : undefined;
}
function EditableVarSourceEditor(props: VarSourceEditorProps) {
  const state = useVarSourceEditor(props);
  useVarSourceEditorDismiss(state);
  return <VarSourceEditorView state={state} />;
}
export function useVarSourceEditor(props: VarSourceEditorProps) {
  const { code, name, onChangeCode } = props;
  const ref = useRef<HTMLDivElement>(null);
  assert(code.length <= LIMITS.ipcFieldCharsMax, 'Source editor: source limit exceeded');
  const codeRef = useRef(code);
  codeRef.current = code;
  const [draft, setDraft] = useState(() => findDeclaration(code, name)?.statement ?? '');
  // What is wrong with the draft, once there has been a reason to say. Empty
  // until the first commit: a statement is unfinished for most of the time it
  // takes to type one, and going red at every keystroke would be nagging about
  // a mistake that hasn't been made yet.
  const [error, setError] = useState('');
  const rangeRef = useRef<{ readonly start: number; readonly end: number } | undefined>(undefined);

  const apply = (text: string) => {
    const source = codeRef.current;
    // Re-locate on every write: the surrounding code can shift under us (an
    // undo, an edit elsewhere). Renaming the variable inside this editor is
    // the one case the lookup can't follow — fall back to where we last wrote.
    const found = findDeclaration(source, name);
    const range = found ? { start: found.start, end: found.end } : rangeRef.current;
    if (!range) {
      return;
    }
    assert(range.start >= 0, 'Source editor: declaration starts inside source');
    assert(range.end <= source.length, 'Source editor: declaration ends inside source');
    rangeRef.current = { start: range.start, end: range.start + text.length };
    onChangeCode?.(source.slice(0, range.start) + text + source.slice(range.end));
  };

  // Nothing is written while typing. This is code being spliced into a file the
  // site is compiled from, so every keystroke used to be compiled — and the
  // half-finished shape of a statement is a build error, which replaced the
  // preview with a stack trace you then had to wait out. It goes in when you
  // leave the field, and only if it parses.
  const commit = (text: string) => {
    if (text === draft && error) {
      return false;
    }
    const verdict = checkStatement(text);
    if (!verdict.ok) {
      setError(verdict.message);
      return false;
    }
    setError('');
    if (text !== (findDeclaration(codeRef.current, name)?.statement ?? '')) {
      apply(text);
    }
    return true;
  };

  // Capture phase: what's inside is CodeMirror and what's around it is the
  // panel's own pointer/key handling, either of which can stop an event before
  // a bubbling listener on the document would see it.
  // Read by the document listener above, which is registered once per render
  // and must not close over a stale draft.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Outside edits (undo) reach the editor as a changed statement; our own
  // writes come back identical, so typing isn't fought.
  const external = findDeclaration(code, name)?.statement;

  return { ...props, ref, draft, setDraft, error, setError, commit, draftRef, external };
}
export type SourceEditorState = ReturnType<typeof useVarSourceEditor>;
export function useVarSourceEditorDismiss({ ref, commit, draftRef, onClose }: SourceEditorState) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current || (event.target instanceof window.Node && ref.current.contains(event.target))) {
        return;
      }
      // A press outside commits, the way leaving any field does — and if that
      // fails, the popup stays up holding the message. Closing on the press
      // that produced the error would be showing it to nobody. Escape and the
      // × still close, so this is a reason to stay, not a trap.
      if (commit(draftRef.current)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
}
export function VarSourceEditorView({ state }: { readonly state: SourceEditorState }) {
  const { ref, pos: position, onClose, name, draft, external, error, setDraft, setError, commit } = state;
  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: position.top, left: position.left, width: position.width }}
      // Escape typed inside the code editor closes the popup, independently of
      // the document listener above.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <SourceEditorHeader name={name} onClose={onClose} />
      <ExprInput
        multiline
        autoFocus
        className="var-src-code"
        value={draft}
        syncValue={external ?? draft}
        invalid={!!error}
        onChange={(text) => {
          setDraft(text);
          // Only once it has already gone red: then it is a correction being
          // watched for, not a running commentary on an unfinished line.
          if (error) {
            setError(checkStatement(text).ok ? '' : error);
          }
        }}
        onCommit={commit}
      />
      {error ? <ErrorToast message={error} /> : undefined}
    </div>
  );
}

export function eventElement(target: unknown): Element | undefined {
  return target instanceof window.Element ? target : undefined;
}

export function SourceEditorHeader({ name, onClose }: { readonly name: string; readonly onClose: () => void }) {
  return (
    <div className="var-src-head">
      <CodeIcon size={12} />
      <span className="var-src-name">{name}</span>
      <span style={{ flex: 1 }} />
      <button className="ghost" title="Close" onClick={onClose}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
