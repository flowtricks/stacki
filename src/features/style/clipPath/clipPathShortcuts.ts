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
  title: 'General',
  items: [
    { keys: 'Arrow keys', description: 'Move the selected handle by 1%.' },
    { keys: 'Space + Arrow keys', description: 'Move by 10% instead of 1%.' },
    { keys: 'Cmd/Ctrl + Z', description: 'Undo the last change.' },
    { keys: 'Cmd/Ctrl + Shift + Z', description: 'Redo the last change.' },
    { keys: 'Paste SVG', description: 'Paste an SVG to build a shape.' },
  ],
};

export const POLYGON_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Polygon',
    items: [
      { keys: 'Drag to select', description: 'Drag to select over multiple points.' },
      { keys: 'Shift + click point', description: 'Select multiple points.' },
      {
        keys: 'Option/Alt + drag point',
        description: 'Duplicate a point by dragging it while holding option/alt.',
      },
      { keys: 'Delete / Backspace', description: 'Delete selected points (3 must remain).' },
      { keys: 'Cmd/Ctrl + D', description: 'Duplicate the selected point.' },
    ],
  },
];

export const CIRCLE_SHORTCUTS: ShortcutHelpGroup[] = [
  { title: 'Center', items: [{ keys: 'drag/arrow keys', description: 'Move the center.' }] },
  { title: 'Radius', items: [{ keys: 'drag/arrow keys', description: 'Resize the radius.' }] },
];

export const ELLIPSE_SHORTCUTS: ShortcutHelpGroup[] = [
  { title: 'Center', items: [{ keys: 'drag/arrow keys', description: 'Move the center.' }] },
  {
    title: 'Radius',
    items: [
      { keys: 'drag/arrow keys', description: 'Resize the selected radius.' },
      {
        keys: 'Shift + drag/arrow keys',
        description: 'Scale both radii, keeping the aspect ratio.',
      },
    ],
  },
];

export const INSET_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Sides',
    items: [
      { keys: 'drag/arrow keys', description: 'Adjust the selected side.' },
      {
        keys: 'Option/Alt + drag/arrow keys',
        description: 'Adjust this side and its opposite side together.',
      },
      { keys: 'Shift + drag/arrow keys', description: 'Adjust all sides together.' },
    ],
  },
  {
    title: 'Corners',
    items: [
      { keys: 'drag/arrow keys', description: 'Round the selected corner.' },
      {
        keys: 'Option/Alt + drag/arrow keys',
        description: 'Round this corner and its opposite together.',
      },
      { keys: 'Shift + drag/arrow keys', description: 'Match all corners to this one.' },
      {
        keys: 'U + drag/arrow keys',
        description: 'Set horizontal and vertical radius separately.',
      },
    ],
  },
];

export const SCALED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Shape',
    items: [
      { keys: 'Drag/arrow keys', description: 'Move the shape.' },
      { keys: 'Drag corner', description: 'Resize toward the opposite corner.' },
      { keys: 'Option/Alt + drag corner', description: 'Resize from the center.' },
    ],
  },
];

export const STRETCHED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Shape',
    items: [{ keys: 'Stretch mode', description: 'Switch to Scale to move or resize.' }],
  },
];

export const NONE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'None',
    items: [
      { keys: 'Paste SVG', description: 'Paste an SVG to build a shape.' },
      { keys: 'Dropdown', description: 'Pick a preset to start editing.' },
    ],
  },
];

export const CUSTOM_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Custom',
    items: [
      { keys: 'Code editor', description: 'Edit the raw clip-path value.' },
      { keys: 'Paste SVG', description: 'Paste an SVG to make it editable.' },
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
