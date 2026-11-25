// German `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Schließe den Editor für Standardwerte, bevor du eine Canvas öffnest.',
  'componentCanvas.error.notOpened': 'Die Komponente wurde nicht auf der Canvas geöffnet. Versuche es erneut.',
  'componentCanvas.error.notReturned': 'Die Rückkehr zur vorherigen Datei ist fehlgeschlagen. Öffne sie im Bereich „Seiten“.',
  'componentCanvas.error.open': 'Die Canvas konnte nicht geöffnet werden: {message}',
  'componentCanvas.error.save': 'Die Canvas-Einstellungen konnten nicht gespeichert werden: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'nicht gesetzt',
  'componentCanvas.menu.open': 'In der Canvas öffnen',
  'componentCanvas.notice.truncated': 'Die ersten {shown} von {total} Frames werden angezeigt. Gib weniger Props eigene Frames, um den Rest zu sehen.',
  'componentCanvas.pageName': '{name}-Canvas',
  'componentCanvas.panel.background': 'Hintergrund',
  'componentCanvas.panel.fixed': 'Fest',
  'componentCanvas.panel.frame.hint':
    'Klicke auf die Beschriftung eines Frames oder auf den Bereich um seine Komponente, um den Frame auszuwählen. Klicke in die Komponente, um sie zu bearbeiten.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    one: '{count} Frame',
    other: '{count} Frames',
  },
  'componentCanvas.panel.height': 'Höhe',
  'componentCanvas.panel.hug': 'An Inhalt',
  'componentCanvas.panel.pixels': '{side} in Pixeln',
  'componentCanvas.panel.props.hint':
    'Womit dieser Frame gerendert wird. Diese Werte bleiben auf der Canvas und sind bei jedem Öffnen wieder da. Sie werden nie in die Komponente oder ihre Instanzen geschrieben.',
  'componentCanvas.panel.props.none': 'Nicht gesetzt',
  'componentCanvas.panel.props.split': 'Jeder Wert von {name} hat einen eigenen Frame.',
  'componentCanvas.panel.props.title': 'Vorschau-Props',
  'componentCanvas.panel.props.unused': 'Diese Variante verwendet {name} nicht.',
  'componentCanvas.panel.scope.all': 'Alle Frames',
  'componentCanvas.panel.scope.frame': 'Dieser Frame',
  'componentCanvas.panel.scope.hint':
    'Wo die von dir festgelegte Größe, der Hintergrund und die Prop-Werte gelten: für diesen Frame, für jeden Frame eines Werts oder für alle Frames. Die eigene Einstellung eines Frames hat Vorrang vor einer weiter gefassten.',
  'componentCanvas.panel.scope.label': 'Anwenden auf',
  'componentCanvas.panel.scope.part': 'Jeder Frame mit {part}',
  'componentCanvas.panel.split.hint':
    'Jeder Wert einer hier eingeschalteten Prop erhält einen eigenen Frame, und die Frames zeigen jede Kombination. Eine ausgeschaltete Prop zeigt pro Frame einen Wert, den du unter „Vorschau-Props“ festlegst.',
  'componentCanvas.panel.split.title': 'Eigene Frames',
  'componentCanvas.panel.split.toggle': 'Jedem Wert von {name} einen eigenen Frame geben',
  'componentCanvas.panel.transparent': 'Transparent', // same
  'componentCanvas.panel.values': {
    one: '{count} Wert',
    other: '{count} Werte',
  },
  'componentCanvas.panel.width': 'Breite',
  'componentCanvas.popup.close': 'Frame-Einstellungen schließen',
  'componentCanvas.popup.title': 'Frame-Einstellungen',
  'componentCanvas.titleBar.close': '{name}-Canvas schließen',
  'componentCanvas.zoom.fit': 'Anpassen',
  'componentCanvas.zoom.fitAll': 'Zoom an alle Frames anpassen',
  'componentCanvas.zoom.in': 'Vergrößern',
  'componentCanvas.zoom.out': 'Verkleinern',
  'componentCanvas.zoom.percent': '{percent} %',
  'componentCanvas.zoom.reset': 'Auf 100 % zoomen',
} as const satisfies CatalogOf<MessageKey>;
