// i18n-ignore-file: the words matchPreset returns are preset ids (compared and used in option ids); `presetLabel` gives the text shown.
// The editor's keyboard shortcuts for each kind of shape, and matching a
// shape to a preset (ClipPath.tsx).

import { type ClipShape, type ShapeFitMode, type ShortcutHelpGroup } from './clipPathTypes';
import { shapesClose } from './clipPathHandles';
import { PRESETS } from './clipPathFormat';

export function shortcutShapeKind(shape: ClipShape) {
  if (shape.kind !== 'raw') {
    return shape.kind;
  }
  return shape.editable?.kind || 'raw';
}

// The shortcuts that hold for every shape.
export const GENERAL_SHORTCUTS: ShortcutHelpGroup = {
  titleKey: 'styleModel.clipPath.shortcut.group.general',
  items: [
    { keys: { message: 'styleModel.clipPath.shortcut.keys.arrowKeys' }, descriptionKey: 'styleModel.clipPath.shortcut.moveHandle' },
    { keys: { message: 'styleModel.clipPath.shortcut.keys.spaceArrowKeys' }, descriptionKey: 'styleModel.clipPath.shortcut.moveTen' },
    { keys: { literal: 'Cmd/Ctrl + Z' }, descriptionKey: 'styleModel.clipPath.shortcut.undo' },
    { keys: { literal: 'Cmd/Ctrl + Shift + Z' }, descriptionKey: 'styleModel.clipPath.shortcut.redo' },
    { keys: { message: 'styleModel.clipPath.shortcut.keys.pasteSvg' }, descriptionKey: 'styleModel.clipPath.shortcut.pasteBuild' },
  ],
};

export const POLYGON_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.preset.polygon',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragSelect' }, descriptionKey: 'styleModel.clipPath.shortcut.dragSelectPoints' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.shiftClickPoint' }, descriptionKey: 'styleModel.clipPath.shortcut.selectMultiple' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.altDragPoint' }, descriptionKey: 'styleModel.clipPath.shortcut.duplicateDrag' },
      { keys: { literal: 'Delete / Backspace' }, descriptionKey: 'styleModel.clipPath.shortcut.deletePoints' },
      { keys: { literal: 'Cmd/Ctrl + D' }, descriptionKey: 'styleModel.clipPath.shortcut.duplicatePoint' },
    ],
  },
];

export const CIRCLE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.shortcut.group.center',
    items: [{ keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.moveCenter' }],
  },
  {
    titleKey: 'styleModel.clipPath.shortcut.group.radius',
    items: [{ keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.resizeRadius' }],
  },
];

export const ELLIPSE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.shortcut.group.center',
    items: [{ keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.moveCenter' }],
  },
  {
    titleKey: 'styleModel.clipPath.shortcut.group.radius',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.resizeSelectedRadius' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.shiftDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.scaleRadii' },
    ],
  },
];

export const INSET_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.shortcut.group.sides',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.adjustSide' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.altDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.adjustOpposite' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.shiftDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.adjustAll' },
    ],
  },
  {
    titleKey: 'styleModel.clipPath.shortcut.group.corners',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.roundCorner' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.altDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.roundOpposite' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.shiftDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.matchCorners' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.uDragArrows' }, descriptionKey: 'styleModel.clipPath.shortcut.separateRadii' },
    ],
  },
];

export const SCALED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.preset.shape',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragArrowsCapital' }, descriptionKey: 'styleModel.clipPath.shortcut.moveShape' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dragCorner' }, descriptionKey: 'styleModel.clipPath.shortcut.resizeOpposite' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.altDragCorner' }, descriptionKey: 'styleModel.clipPath.shortcut.resizeCenter' },
    ],
  },
];

export const STRETCHED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.preset.shape',
    items: [{ keys: { message: 'styleModel.clipPath.shortcut.keys.stretchMode' }, descriptionKey: 'styleModel.clipPath.shortcut.switchToScale' }],
  },
];

export const NONE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.preset.none',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.pasteSvg' }, descriptionKey: 'styleModel.clipPath.shortcut.pasteBuild' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.dropdown' }, descriptionKey: 'styleModel.clipPath.shortcut.pickPreset' },
    ],
  },
];

export const CUSTOM_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    titleKey: 'styleModel.clipPath.preset.custom',
    items: [
      { keys: { message: 'styleModel.clipPath.shortcut.keys.codeEditor' }, descriptionKey: 'styleModel.clipPath.shortcut.editRaw' },
      { keys: { message: 'styleModel.clipPath.shortcut.keys.pasteSvg' }, descriptionKey: 'styleModel.clipPath.shortcut.pasteEditable' },
    ],
  },
];

// The shortcut help by the kind of shape being edited; anything else is custom.
export const SHORTCUTS_BY_KIND: Partial<Record<string, ShortcutHelpGroup[]>> = {
  polygon: POLYGON_SHORTCUTS,
  circle: CIRCLE_SHORTCUTS,
  ellipse: ELLIPSE_SHORTCUTS,
  inset: INSET_SHORTCUTS,
  none: NONE_SHORTCUTS,
};

// The shortcut help for the shape being edited, then the general shortcuts.
export function clipPathShortcutGroups(shape: ClipShape, shapeFitMode: ShapeFitMode): ShortcutHelpGroup[] {
  const kind = shortcutShapeKind(shape);
  if (kind === 'shape') {
    const shapeGroups = shapeFitMode === 'contain' ? SCALED_SHAPE_SHORTCUTS : STRETCHED_SHAPE_SHORTCUTS;
    return [...shapeGroups, GENERAL_SHORTCUTS];
  }
  return [...(SHORTCUTS_BY_KIND[kind] ?? CUSTOM_SHORTCUTS), GENERAL_SHORTCUTS];
}

export function matchPreset(shape: ClipShape): string | undefined {
  if (shape.kind === 'polygon') {
    return 'Polygon';
  }
  if (shape.kind === 'circle') {
    return 'Circle';
  }
  if (shape.kind === 'ellipse') {
    return 'Ellipse';
  }
  if (shape.kind === 'inset') {
    return 'Inset';
  }
  if (shape.kind === 'shape') {
    return 'Shape';
  }
  if (shape.kind === 'raw') {
    return shape.preset || undefined;
  }

  for (const [name, preset] of Object.entries(PRESETS)) {
    if (shapesClose(preset, shape)) {
      return name;
    }
  }
  return undefined;
}

export function presetOptionId(name: string) {
  return `clip-path_preset-option-${name.toLowerCase().replace(/\s+/g, '-')}`;
}
