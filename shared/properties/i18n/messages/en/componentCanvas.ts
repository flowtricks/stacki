// English `componentCanvas` strings: the source of truth for every key beginning `componentCanvas.` (docs/i18n.md). Alphabetical.
// The component canvas: a component's variants side by side in frames, opened from the Components panel's "…" menu.
import type { CatalogOf } from '../../../../core/i18n/catalog';

export const messages = {
  'componentCanvas.error.busy': 'Close the defaults editor before opening a canvas.',
  'componentCanvas.error.notOpened': 'The component didn’t open on the canvas. Try again.',
  'componentCanvas.error.notReturned': 'Couldn’t go back to the file you were on. Open it from the Pages panel.',
  'componentCanvas.error.open': 'The canvas couldn’t open: {message}',
  'componentCanvas.error.save': 'The canvas settings couldn’t be saved: {message}',
  'componentCanvas.frame.part': '{prop}: {value}',
  'componentCanvas.frame.unset': 'not set',
  'componentCanvas.menu.open': 'Open in canvas',
  'componentCanvas.notice.truncated': 'Showing the first {shown} of {total} frames. Give fewer props their own frames to see the rest.',
  'componentCanvas.pageName': '{name} canvas',
  'componentCanvas.panel.background': 'Background',
  'componentCanvas.panel.backgroundVariable': 'Connect a variable',
  'componentCanvas.panel.fixed': 'Fixed',
  'componentCanvas.panel.frame.hint': 'Click a frame’s label or the space around its component to select the frame. Click inside the component to edit it.',
  'componentCanvas.panel.frame.pick': 'Frame',
  'componentCanvas.panel.frame.title': 'Frame',
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frames',
  },
  'componentCanvas.panel.height': 'Height',
  'componentCanvas.panel.hug': 'Hug',
  'componentCanvas.panel.pixels': '{side} in pixels',
  'componentCanvas.panel.props.hint':
    'What this frame renders with. These values stay on the canvas and come back each time you open it. They’re never written to the component or its instances.',
  'componentCanvas.panel.props.none': 'Not set',
  'componentCanvas.panel.props.split': 'Each value of {name} has its own frame.',
  'componentCanvas.panel.props.title': 'Preview props',
  'componentCanvas.panel.props.unused': 'This variant doesn’t use {name}.',
  'componentCanvas.panel.scope.all': 'All frames',
  'componentCanvas.panel.scope.frame': 'This frame',
  'componentCanvas.panel.scope.hint':
    'Where the size, background and prop values you set apply: this frame, every frame of one value, or every frame. A frame’s own setting wins over a wider one.',
  'componentCanvas.panel.scope.label': 'Apply to',
  'componentCanvas.panel.scope.part': 'Every {part} frame',
  'componentCanvas.panel.scope.project': 'All components',
  'componentCanvas.panel.split.hint':
    'Each value of a prop switched on here gets its own frame, and the frames show every combination. A prop left off shows one value per frame, which you set in Preview props.',
  'componentCanvas.panel.split.title': 'Own frames',
  'componentCanvas.panel.split.toggle': 'Give each value of {name} its own frame',
  'componentCanvas.panel.transparent': 'Transparent',
  'componentCanvas.panel.values': {
    one: '{count} value',
    other: '{count} values',
  },
  'componentCanvas.panel.width': 'Width',
  'componentCanvas.popup.close': 'Close frame settings',
  'componentCanvas.popup.title': 'Frame settings',
  'componentCanvas.titleBar.close': 'Close {name} canvas',
  'componentCanvas.zoom.fit': 'Fit',
  'componentCanvas.zoom.fitAll': 'Zoom to fit every frame',
  'componentCanvas.zoom.in': 'Zoom in',
  'componentCanvas.zoom.out': 'Zoom out',
  'componentCanvas.zoom.percent': '{percent}%',
  'componentCanvas.zoom.reset': 'Zoom to 100%',
} as const satisfies CatalogOf<`componentCanvas.${string}`>;

export type MessageKey = keyof typeof messages;
