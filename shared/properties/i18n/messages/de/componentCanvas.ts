// German `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Schließe den Editor für Standardwerte, bevor du eine Canvas öffnest.',
  'componentCanvas.error.notOpened': 'Die Komponente wurde nicht auf der Canvas geöffnet. Versuche es erneut.',
  'componentCanvas.error.notReturned': 'Die Rückkehr zur vorherigen Datei ist fehlgeschlagen. Öffne sie im Bereich „Seiten“.',
  'componentCanvas.error.open': 'Die Canvas konnte nicht geöffnet werden: {message}',
  'componentCanvas.error.pageReadOnly': 'Diese Canvas zeigt nur die Komponente an. Doppelklicke auf einen Frame, um die Komponente darin zu bearbeiten.',
  'componentCanvas.error.previewValue': 'Ein Frame kann für {name} einen Wert als Vorschau zeigen, aber keinen Code.',
  'componentCanvas.error.save': 'Die Canvas-Einstellungen konnten nicht gespeichert werden: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'nicht gesetzt',
  'componentCanvas.level.all': 'Für alle Frames festgelegt',
  'componentCanvas.level.frame': 'Dieser Frame hat einen eigenen Wert',
  'componentCanvas.level.overrides': {
    one: '{count} Frame hier behält seinen eigenen Wert. Setze zurück, um ihm diesen zu geben.',
    other: '{count} Frames hier behalten ihren eigenen Wert. Setze zurück, um ihnen diesen zu geben.',
  },
  'componentCanvas.level.part': 'Für jeden Frame mit {part} festgelegt',
  'componentCanvas.menu.open': 'In der Canvas öffnen',
  'componentCanvas.notice.truncated': 'Die ersten {shown} von {total} Frames werden angezeigt. Gib weniger Props eigene Frames, um den Rest zu sehen.',
  'componentCanvas.pageName': '{name}-Canvas',
  'componentCanvas.panel.background': 'Hintergrund',
  'componentCanvas.panel.backgroundVariable': 'Mit Variable verbinden',
  'componentCanvas.panel.fixed': 'Fest',
  'componentCanvas.panel.frames': {
    one: '{count} Frame',
    other: '{count} Frames',
  },
  'componentCanvas.panel.height': 'Höhe',
  'componentCanvas.panel.hug': 'An Inhalt',
  'componentCanvas.panel.pixels': '{side} in Pixeln',
  'componentCanvas.panel.root.about': 'Die Canvas hinter allen Frames: das html-Element der Seite. Ihre Klassen findest du im Einstellungen-Panel.',
  'componentCanvas.panel.root.title': 'Canvas', // same
  'componentCanvas.panel.scope.all': 'Alle Frames',
  'componentCanvas.panel.scope.component': 'Diese Komponente',
  'componentCanvas.panel.scope.frame': 'Dieser Frame',
  'componentCanvas.panel.scope.hint':
    'Wo die von dir festgelegte Größe, der Hintergrund und die Prop-Werte gelten: für diesen Frame, für jeden Frame eines Werts oder für alle Frames. Die eigene Einstellung eines Frames hat Vorrang vor einer weiter gefassten.',
  'componentCanvas.panel.scope.label': 'Anwenden auf',
  'componentCanvas.panel.scope.part': 'Jeder Frame mit {part}',
  'componentCanvas.panel.scope.project': 'Alle Komponenten',
  'componentCanvas.panel.size': 'Größe',
  'componentCanvas.panel.transparent': 'Transparent', // same
  'componentCanvas.panel.width': 'Breite',
  'componentCanvas.popup.expand': 'Frame-Einstellungen ausklappen',
  'componentCanvas.popup.minimize': 'Frame-Einstellungen minimieren',
  'componentCanvas.popup.title': 'Frame-Einstellungen',
  'componentCanvas.scope.valueFrames': 'Alle Frames mit {value}',
  'componentCanvas.split.full': 'Bis zu {max} Props können eigene Frames haben. Schalte zuerst eine davon aus.',
  'componentCanvas.split.locked': 'Jeder Wert von {name} hat einen eigenen Frame.',
  'componentCanvas.split.off': {
    one: 'Jedem Wert von {name} einen eigenen Frame geben ({count} Wert)',
    other: 'Jedem Wert von {name} einen eigenen Frame geben ({count} Werte)',
  },
  'componentCanvas.split.on': '{name} in einem Frame anzeigen',
  'componentCanvas.titleBar.close': '{name}-Canvas schließen',
  'componentCanvas.zoom.fit': 'Anpassen',
  'componentCanvas.zoom.fitAll': 'Zoom an alle Frames anpassen',
  'componentCanvas.zoom.in': 'Vergrößern',
  'componentCanvas.zoom.out': 'Verkleinern',
  'componentCanvas.zoom.percent': '{percent} %',
  'componentCanvas.zoom.reset': 'Auf 100 % zoomen',
} as const satisfies CatalogOf<MessageKey>;
