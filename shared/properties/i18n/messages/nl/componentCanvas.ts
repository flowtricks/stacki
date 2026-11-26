// Dutch `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Sluit de editor voor standaardwaarden voordat je een canvas opent.',
  'componentCanvas.error.notOpened': 'Het component is niet op het canvas geopend. Probeer het opnieuw.',
  'componentCanvas.error.notReturned': 'Teruggaan naar het bestand waar je was is niet gelukt. Open het via het paneel Pagina’s.',
  'componentCanvas.error.open': 'Het canvas kon niet worden geopend: {message}',
  'componentCanvas.error.pageReadOnly': 'Dit canvas toont alleen het component. Dubbelklik op een frame om het component erin te bewerken.',
  'componentCanvas.error.previewValue': 'Een frame kan voor {name} een voorbeeld van een waarde tonen, maar niet van code.',
  'componentCanvas.error.save': 'De canvasinstellingen konden niet worden opgeslagen: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'niet ingesteld',
  'componentCanvas.framePanel.hide': 'Frame-instellingen verbergen',
  'componentCanvas.framePanel.show': 'Frame-instellingen tonen',
  'componentCanvas.level.all': 'Ingesteld voor alle frames',
  'componentCanvas.level.frame': 'Dit frame heeft een eigen waarde',
  'componentCanvas.level.part': 'Ingesteld voor elk {part}-frame',
  'componentCanvas.menu.open': 'Op canvas openen',
  'componentCanvas.notice.truncated': 'De eerste {shown} van {total} frames worden getoond. Geef minder props eigen frames om de rest te zien.',
  'componentCanvas.pageName': 'Canvas van {name}',
  'componentCanvas.panel.background': 'Achtergrond',
  'componentCanvas.panel.backgroundVariable': 'Aan variabele koppelen',
  'componentCanvas.panel.fixed': 'Vast',
  'componentCanvas.panel.frame.about': 'Klik op een frame om het component ervan te selecteren en dubbelklik erop om het component erin te bewerken.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frames',
  },
  'componentCanvas.panel.height': 'Hoogte',
  'componentCanvas.panel.hug': 'Naar inhoud',
  'componentCanvas.panel.pixels': '{side} in pixels', // same
  'componentCanvas.panel.root.about': 'Het canvas achter alle frames: het html-element van de pagina. De klassen ervan staan in het paneel Instellingen.',
  'componentCanvas.panel.root.title': 'Canvas', // same
  'componentCanvas.panel.scope.all': 'Alle frames',
  'componentCanvas.panel.scope.component': 'Dit component',
  'componentCanvas.panel.scope.frame': 'Dit frame',
  'componentCanvas.panel.scope.hint':
    'Waar het formaat, de achtergrond en de propwaarden die je instelt gelden: voor dit frame, voor elk frame van één waarde of voor alle frames. De eigen instelling van een frame gaat voor op een bredere.',
  'componentCanvas.panel.scope.label': 'Toepassen op',
  'componentCanvas.panel.scope.part': 'Elk frame met {part}',
  'componentCanvas.panel.scope.project': 'Alle componenten',
  'componentCanvas.panel.transparent': 'Transparant',
  'componentCanvas.panel.width': 'Breedte',
  'componentCanvas.popup.close': 'Frame-instellingen sluiten',
  'componentCanvas.popup.title': 'Frame-instellingen',
  'componentCanvas.split.full': 'Maximaal {max} props kunnen eigen frames hebben. Zet er eerst een uit.',
  'componentCanvas.split.locked': 'Elke waarde van {name} heeft een eigen frame.',
  'componentCanvas.split.off': {
    one: 'Elke waarde van {name} een eigen frame geven ({count} waarde)',
    other: 'Elke waarde van {name} een eigen frame geven ({count} waarden)',
  },
  'componentCanvas.split.on': '{name} in één frame tonen',
  'componentCanvas.titleBar.close': 'Canvas van {name} sluiten',
  'componentCanvas.zoom.fit': 'Passend',
  'componentCanvas.zoom.fitAll': 'Zoomen zodat alle frames passen',
  'componentCanvas.zoom.in': 'Inzoomen',
  'componentCanvas.zoom.out': 'Uitzoomen',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoomen naar 100%',
} as const satisfies CatalogOf<MessageKey>;
