// Dutch `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Sluit de editor voor standaardwaarden voordat je een canvas opent.',
  'componentCanvas.error.notOpened': 'Het component is niet op het canvas geopend. Probeer het opnieuw.',
  'componentCanvas.error.notReturned': 'Teruggaan naar het bestand waar je was is niet gelukt. Open het via het paneel Pagina’s.',
  'componentCanvas.error.open': 'Het canvas kon niet worden geopend: {message}',
  'componentCanvas.error.save': 'De canvasinstellingen konden niet worden opgeslagen: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'niet ingesteld',
  'componentCanvas.menu.open': 'Op canvas openen',
  'componentCanvas.notice.truncated': 'De eerste {shown} van {total} frames worden getoond. Geef minder props eigen frames om de rest te zien.',
  'componentCanvas.pageName': 'Canvas van {name}',
  'componentCanvas.panel.background': 'Achtergrond',
  'componentCanvas.panel.fixed': 'Vast',
  'componentCanvas.panel.frame.hint':
    'Klik op het label van een frame of op de ruimte rond het component om het frame te selecteren. Klik in het component om het te bewerken.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frames',
  },
  'componentCanvas.panel.height': 'Hoogte',
  'componentCanvas.panel.hug': 'Naar inhoud',
  'componentCanvas.panel.pixels': '{side} in pixels', // same
  'componentCanvas.panel.props.hint':
    'Waarmee dit frame wordt gerenderd. Deze waarden blijven op het canvas en komen terug telkens wanneer je het opent. Ze worden nooit naar het component of de instanties ervan geschreven.',
  'componentCanvas.panel.props.none': 'Niet ingesteld',
  'componentCanvas.panel.props.split': 'Elke waarde van {name} heeft een eigen frame.',
  'componentCanvas.panel.props.title': 'Previewprops',
  'componentCanvas.panel.props.unused': 'Deze variant gebruikt {name} niet.',
  'componentCanvas.panel.scope.all': 'Alle frames',
  'componentCanvas.panel.scope.frame': 'Dit frame',
  'componentCanvas.panel.scope.hint':
    'Waar het formaat, de achtergrond en de propwaarden die je instelt gelden: voor dit frame, voor elk frame van één waarde of voor alle frames. De eigen instelling van een frame gaat voor op een bredere.',
  'componentCanvas.panel.scope.label': 'Toepassen op',
  'componentCanvas.panel.scope.part': 'Elk frame met {part}',
  'componentCanvas.panel.split.hint':
    'Elke waarde van een prop die hier is ingeschakeld krijgt een eigen frame, en de frames tonen elke combinatie. Een uitgeschakelde prop toont één waarde per frame, die je instelt bij Previewprops.',
  'componentCanvas.panel.split.title': 'Eigen frames',
  'componentCanvas.panel.split.toggle': 'Elke waarde van {name} een eigen frame geven',
  'componentCanvas.panel.transparent': 'Transparant',
  'componentCanvas.panel.values': {
    one: '{count} waarde',
    other: '{count} waarden',
  },
  'componentCanvas.panel.width': 'Breedte',
  'componentCanvas.popup.close': 'Frame-instellingen sluiten',
  'componentCanvas.popup.title': 'Frame-instellingen',
  'componentCanvas.titleBar.close': 'Canvas van {name} sluiten',
  'componentCanvas.zoom.fit': 'Passend',
  'componentCanvas.zoom.fitAll': 'Zoomen zodat alle frames passen',
  'componentCanvas.zoom.in': 'Inzoomen',
  'componentCanvas.zoom.out': 'Uitzoomen',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoomen naar 100%',
} as const satisfies CatalogOf<MessageKey>;
