import Popup from '../../../ui/Popup';
// The clip-path editor's view: its class tags, presets and source menu, fit
// mode and scale variables, shortcut help, and the canvas (ClipPath.tsx).

import { createPortal } from 'react-dom';
import { CodeEditor } from '../components/CssCodeEditor';
import SegmentedControl from '../components/SegmentedControl';
import ClassPicker from '../components/ClassPicker';
import { type ShapeFitMode, type ShapeScaleOptionOverrides } from './clipPathTypes';
import {
  BREAKPOINT_LABELS,
  CLIP_PATH_CODE_ID,
  SHAPE_SCALE_VARIABLE_PLACEHOLDER,
  SHAPE_OFFSET_LEFT_VARIABLE_PLACEHOLDER,
  SHAPE_OFFSET_TOP_VARIABLE_PLACEHOLDER,
} from './clipPathConstants';
import { formatShapeVariableField } from './clipPathMeasure';
import VariableConnect from '../VariableConnect';
import { PRESETS, PRESET_NAMES } from './clipPathFormat';
import { presetOptionId } from './clipPathShortcuts';
import { BreakpointIcon, PresetIcon } from './ClipPathIcons';
import { type EditorProps } from './clipPathWriteActions';
import { ShortcutHelpGroups, ClipPathCanvas } from './ClipPathCanvas';

// The editor: the class tags, the preset menu, the canvas, and the code.
export function ClipPathView({ editor }: EditorProps) {
  const { shortcutHelpPortalTarget, hideClassPicker, codeValue } = editor;
  const { selectedCodeTokenHighlights, onCodeChange, onCodeSelectionChange } = editor;
  return (
    <div className="clip-path_component">
      {shortcutHelpPortalTarget ? createPortal(<ShortcutHelpControl editor={editor} />, shortcutHelpPortalTarget) : undefined}
      {hideClassPicker ? undefined : <ClassTagsControl editor={editor} />}
      <PresetControl editor={editor} />
      <ClipPathCanvas editor={editor} />
      <ShapeFitControl editor={editor} />
      <ShapeScaleVariableControl editor={editor} />

      <CodeEditor
        id={CLIP_PATH_CODE_ID}
        className="clip-path_code"
        value={codeValue}
        language="css"
        ariaLabel="Editable clip-path CSS"
        // The code is the whole clip-path value: binding it makes that value `var(--x)`.
        variables={{ kind: 'value', prop: 'clip-path' }}
        tokenHighlights={selectedCodeTokenHighlights}
        onChange={onCodeChange}
        onSelectionChange={onCodeSelectionChange}
      />
    </div>
  );
}

// The element's classes as tags; picking some targets their style.
export function ClassTagsControl({ editor }: EditorProps) {
  const { elementClassNames, selectedClassNames, handleClassSelectionChange } = editor;
  const { selectedSelector } = editor;
  if (!elementClassNames.length) {
    return undefined;
  }
  return (
    <ClassPicker
      className="clip-path_classes"
      tokens={elementClassNames.map((name) => ({ name, kind: 'class' }))}
      selected={selectedClassNames}
      onChange={handleClassSelectionChange}
      tagTitle={(token, isActive) =>
        selectedSelector && isActive ? `Editing clip path on ${selectedSelector}` : `Edit clip path on .${token.name} — Shift/Option-click to combine`
      }
    />
  );
}

// The "Clip Path" label (with its reset menu or its source popover) and the preset
// dropdown.
export function PresetControl({ editor }: EditorProps) {
  const { isPresetOpen, isClipPathLabelMenuOpen, clipPathStyleOrigin } = editor;
  const { isShortcutHelpOpen } = editor;
  return (
    <div
      className={[
        'clip-path_control-row',
        isPresetOpen ? 'is-dropdown-open' : '',
        isClipPathLabelMenuOpen && clipPathStyleOrigin !== 'none' ? 'is-label-menu-open' : '',
        isShortcutHelpOpen ? 'is-shortcuts-open' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ClipPathLabel editor={editor} />
      <div className="clip-path_control-field">
        <PresetDropdown editor={editor} />
      </div>
    </div>
  );
}

// The label: blue when this breakpoint sets the clip-path (a menu to reset it),
// orange when it is inherited (a popover naming where it comes from).
export function ClipPathLabel({ editor }: EditorProps) {
  const { clipPathLabelRef, clipPathStyleOrigin, clipPathLabelClassName } = editor;
  const { isClipPathLabelMenuOpen, onClipPathLabelClick, resetCurrentBreakpointClipPath } = editor;
  return (
    <div className="clip-path_control-label-wrap" ref={clipPathLabelRef}>
      {clipPathStyleOrigin !== 'none' ? (
        <button
          id="clip-path_preset-label"
          type="button"
          className={`${clipPathLabelClassName} clip-path_control-label-button`}
          aria-haspopup={clipPathStyleOrigin === 'current' ? 'menu' : 'dialog'}
          aria-expanded={isClipPathLabelMenuOpen}
          onClick={onClipPathLabelClick}
        >
          Clip Path
        </button>
      ) : (
        <span className={clipPathLabelClassName} id="clip-path_preset-label">
          Clip Path
        </span>
      )}
      {isClipPathLabelMenuOpen && clipPathStyleOrigin === 'current' ? (
        <Popup mode="popover" portal={false} onClose={() => editor.setIsClipPathLabelMenuOpen(false)} className="clip-path_label-menu" role="menu">
          <button type="button" className="clip-path_label-menu-item" role="menuitem" onClick={() => void resetCurrentBreakpointClipPath()}>
            <svg className="clip-path_label-menu-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.2 5.2H2.2V2.2" />
              <path d="M2.6 5.2A5.5 5.5 0 1 1 4 12.2" />
            </svg>
            <span>Reset</span>
            <span className="clip-path_label-menu-shortcut">Option + click</span>
          </button>
        </Popup>
      ) : undefined}
      {isClipPathLabelMenuOpen && clipPathStyleOrigin === 'inherited' ? <ClipPathSourceMenu editor={editor} /> : undefined}
    </div>
  );
}

// Where an inherited clip-path comes from: its breakpoint and its selector.
export function ClipPathSourceMenu({ editor }: EditorProps) {
  const { clipPathSourceBreakpoint, clipPathSourceSelector, appliedClassName } = editor;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={() => editor.setIsClipPathLabelMenuOpen(false)}
      className="clip-path_label-menu clip-path_source-menu"
      role="dialog"
      label="Clip path value source"
    >
      <span className="clip-path_source-title">Value comes from:</span>
      <div className="clip-path_source-row">
        {clipPathSourceBreakpoint ? (
          <span className="clip-path_source-breakpoint" title={BREAKPOINT_LABELS[clipPathSourceBreakpoint]}>
            <BreakpointIcon breakpoint={clipPathSourceBreakpoint} />
            {BREAKPOINT_LABELS[clipPathSourceBreakpoint]}
          </span>
        ) : undefined}
        {(clipPathSourceSelector.length ? clipPathSourceSelector : appliedClassName ? [appliedClassName] : []).map((name) => (
          <span className="clip-path_source-class" key={name}>
            {name}
          </span>
        ))}
      </div>
    </Popup>
  );
}

// The preset button and, while open, its listbox.
export function PresetDropdown({ editor }: EditorProps) {
  const { presetDropdownRef, presetButtonRef, isPresetOpen, closePresetDropdown } = editor;
  const { setIsShortcutHelpOpen, openPresetDropdown, onPresetButtonKeyDown } = editor;
  const { selectedPresetShape, activePreset } = editor;
  return (
    <div className="clip-path_preset" ref={presetDropdownRef}>
      <button
        id="clip-path_preset-button"
        ref={presetButtonRef}
        type="button"
        className="clip-path_preset-button"
        aria-haspopup="listbox"
        aria-expanded={isPresetOpen}
        aria-controls="clip-path_preset-listbox"
        aria-labelledby="clip-path_preset-label clip-path_preset-button"
        onClick={() => {
          if (isPresetOpen) {
            closePresetDropdown();
          } else {
            setIsShortcutHelpOpen(false);
            openPresetDropdown();
          }
        }}
        onKeyDown={onPresetButtonKeyDown}
      >
        <span className="clip-path_preset-value">
          <PresetIcon shape={selectedPresetShape} />
          <span className="clip-path_preset-name">{activePreset}</span>
        </span>
        <svg className="clip-path_preset-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 6.2 8 10l3.8-3.8" />
        </svg>
      </button>

      {isPresetOpen ? <PresetList editor={editor} /> : undefined}
    </div>
  );
}

// The presets, each with its icon; hovering one makes it the active option.
export function PresetList({ editor }: EditorProps) {
  const { presetListRef, activePresetOptionId, onPresetListKeyDown, activePreset } = editor;
  const { activePresetIndex, setActivePresetIndex, choosePreset } = editor;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={editor.closePresetDropdown}
      anchor={editor.presetButtonRef.current ?? undefined}
      id="clip-path_preset-listbox"
      ref={presetListRef}
      className="clip-path_preset-list"
      role="listbox"
      tabIndex={-1}
      labelledBy="clip-path_preset-label"
      aria-activedescendant={activePresetOptionId}
      onKeyDown={onPresetListKeyDown}
    >
      {PRESET_NAMES.map((name, index) => {
        const optionShape = PRESETS[name];
        if (!optionShape) {
          return undefined;
        }
        const isSelected = activePreset === name;

        return (
          <div
            key={name}
            id={presetOptionId(name)}
            className={['clip-path_preset-option', index === activePresetIndex ? 'is-active' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
            role="option"
            aria-selected={isSelected}
            onMouseEnter={() => setActivePresetIndex(index)}
            onClick={() => choosePreset(name)}
          >
            <PresetIcon shape={optionShape} />
            <span className="clip-path_preset-name">{name}</span>
          </div>
        );
      })}
    </Popup>
  );
}

// How a pasted shape fits the element: scaled to the container, or stretched.
export function ShapeFitControl({ editor }: EditorProps) {
  const { activePreset, shapeFitMode, setShapeFitModeFromControl } = editor;
  if (activePreset !== 'Shape') {
    return undefined;
  }
  return (
    <div className="clip-path_control-row clip-path_control-row--with-help">
      <label className="clip-path_control-label" id="clip-path_shape-fit-label">
        Fit
      </label>
      <div className="clip-path_control-field">
        <SegmentedControl<ShapeFitMode>
          ariaLabel="Fit"
          value={shapeFitMode}
          onChange={setShapeFitModeFromControl}
          options={[
            { value: 'contain', label: 'Scale' },
            { value: 'stretch', label: 'Stretch' },
          ]}
        />
      </div>
      {shapeFitMode === 'contain' ? (
        <p className="clip-path_control-help">
          <svg className="clip-path_control-help-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.5 6.2a2 2 0 0 1 3.8.9c0 1.8-2.2 1.6-2.2 3" />
            <path d="M8 12.2h.01" />
          </svg>
          <span>Apply container-type: size; to the parent</span>
        </p>
      ) : undefined}
    </div>
  );
}

// A shape-variable row's label, with its explanation on hover.
export function ShapeVariableLabel({ id, text, tip }: { id: string; text: string; tip: string }) {
  return (
    <div className="clip-path_label-with-help">
      <label className="clip-path_control-label" id={id}>
        {text}
      </label>
      <span className="clip-path_label-help">
        <button type="button" className="clip-path_label-help-button" aria-label={tip}>
          <svg className="clip-path_label-help-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.5 6.2a2 2 0 0 1 3.8.9c0 1.8-2.2 1.6-2.2 3" />
            <path d="M8 12.2h.01" />
          </svg>
        </button>
        <span className="clip-path_label-help-tip" aria-hidden="true">
          {tip}
        </span>
      </span>
    </div>
  );
}

// A shape-variable field: a custom property the shape() reads, bound the way any
// other Style panel value is, from the purple dot, by typing `--`, or by typing its
// name. A bound field holds `var(--name)` and shows it as a chip; a typed name is
// tidied into that reference on blur. `prop` filters the chooser to the variables
// that fit: a length for the size (as `width` takes), and a plain number for an
// offset (as `opacity`, the panel's other 0 to 1 number, takes).
export function ShapeVariableInput({
  id,
  labelId,
  label,
  prop,
  value,
  placeholder,
  apply,
}: {
  id: string;
  labelId: string;
  label: string;
  prop: string;
  value: string;
  placeholder: string;
  apply: (fieldText: string) => void;
}) {
  return (
    <div className="clip-path_control-field clip-path_variable-field">
      <VariableConnect ariaLabel={`Connect ${label} to a variable`} prop={prop} onPick={(binding) => apply(formatShapeVariableField(binding))}>
        <input
          id={id}
          className="u-input clip-path_variable-input"
          value={value}
          onChange={(event) => apply(event.target.value)}
          onBlur={(event) => {
            const formatted = formatShapeVariableField(event.target.value);
            if (event.target.value !== formatted) {
              apply(formatted);
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-labelledby={labelId}
        />
      </VariableConnect>
    </div>
  );
}

// The variables a scaled shape reads: its size and its X / Y offsets.
export function ShapeScaleVariableControl({ editor }: EditorProps) {
  const { activePreset, shapeFitMode, shapeScaleVariableName } = editor;
  const { setShapeScaleOptionsFromControl, currentShapeScaleOptions } = editor;
  const { shapeOffsetLeftVariableName, shapeOffsetTopVariableName } = editor;
  if (activePreset !== 'Shape' || shapeFitMode !== 'contain') {
    return undefined;
  }
  const apply = (overrides: ShapeScaleOptionOverrides) => setShapeScaleOptionsFromControl(currentShapeScaleOptions(overrides));
  return (
    <>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-variable-label"
          text="Size"
          tip={'This optional variable allows us to animate shape size or change size based on ' + 'screen size'}
        />
        <ShapeVariableInput
          id="clip-path_shape-variable-input"
          labelId="clip-path_shape-variable-label"
          label="Size"
          prop="width"
          value={shapeScaleVariableName}
          placeholder={SHAPE_SCALE_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ variableName: name })}
        />
      </div>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-offset-left-label"
          text="Offset X"
          tip="Optional variable to animate or shift the shape horizontally (0 = left, 1 = right)."
        />
        <ShapeVariableInput
          id="clip-path_shape-offset-left-input"
          labelId="clip-path_shape-offset-left-label"
          label="Offset X"
          prop="opacity"
          value={shapeOffsetLeftVariableName}
          placeholder={SHAPE_OFFSET_LEFT_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ offsetLeftVariableName: name })}
        />
      </div>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-offset-top-label"
          text="Offset Y"
          tip="Optional variable to animate or shift the shape vertically (0 = top, 1 = bottom)."
        />
        <ShapeVariableInput
          id="clip-path_shape-offset-top-input"
          labelId="clip-path_shape-offset-top-label"
          label="Offset Y"
          prop="opacity"
          value={shapeOffsetTopVariableName}
          placeholder={SHAPE_OFFSET_TOP_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ offsetTopVariableName: name })}
        />
      </div>
    </>
  );
}

// The "?" button in the header and its keyboard-shortcut popover.
export function ShortcutHelpControl({ editor }: EditorProps) {
  const { shortcutHelpRef, isShortcutHelpOpen, closePresetDropdown } = editor;
  const { setIsShortcutHelpOpen, selectedPresetShape, activePreset } = editor;
  return (
    <div className="clip-path_shortcuts" ref={shortcutHelpRef}>
      <button
        type="button"
        className="clip-path_shortcuts-button"
        aria-label="Show Clip Path shortcuts"
        aria-haspopup="dialog"
        aria-expanded={isShortcutHelpOpen}
        aria-controls="clip-path_shortcuts-popover"
        onClick={() => {
          closePresetDropdown();
          setIsShortcutHelpOpen((isOpen) => !isOpen);
        }}
      >
        <svg className="clip-path_shortcuts-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.4 6.2a1.8 1.8 0 1 1 2.9 1.4c-.7.5-1.1.8-1.1 1.8" />
          <path d="M8 11.8h.01" />
        </svg>
      </button>
      {isShortcutHelpOpen ? (
        <Popup
          mode="popover"
          portal={false}
          onClose={() => setIsShortcutHelpOpen(false)}
          id="clip-path_shortcuts-popover"
          className="clip-path_shortcuts-popover"
          role="dialog"
          label="Clip Path shortcuts"
        >
          <div className="clip-path_shortcuts-header">
            <span className="clip-path_shortcuts-title">Shortcuts</span>
            <span className="clip-path_shortcuts-preset">
              <PresetIcon shape={selectedPresetShape} />
              <span className="clip-path_shortcuts-preset-name">{activePreset}</span>
            </span>
          </div>
          <ShortcutHelpGroups editor={editor} />
        </Popup>
      ) : undefined}
    </div>
  );
}
