// Polish `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Zamknij edytor wartości domyślnych, zanim otworzysz kanwę.',
  'componentCanvas.error.notOpened': 'Komponent nie otworzył się na kanwie. Spróbuj ponownie.',
  'componentCanvas.error.notReturned': 'Nie udało się wrócić do poprzedniego pliku. Otwórz go z panelu Strony.',
  'componentCanvas.error.open': 'Nie można otworzyć kanwy: {message}',
  'componentCanvas.error.save': 'Nie można zapisać ustawień kanwy: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'nie ustawiono',
  'componentCanvas.menu.open': 'Otwórz na kanwie',
  'componentCanvas.notice.truncated': 'Wyświetlane ramki: pierwsze {shown} z {total}. Aby zobaczyć pozostałe, daj własne ramki mniejszej liczbie właściwości.',
  'componentCanvas.pageName': 'Kanwa {name}',
  'componentCanvas.panel.background': 'Tło',
  'componentCanvas.panel.backgroundVariable': 'Połącz ze zmienną',
  'componentCanvas.panel.fixed': 'Stały',
  'componentCanvas.panel.frame.hint':
    'Kliknij etykietę ramki lub miejsce wokół jej komponentu, aby zaznaczyć ramkę. Kliknij wewnątrz komponentu, aby go edytować.',
  'componentCanvas.panel.frame.pick': 'Ramka',
  'componentCanvas.panel.frame.title': 'Ramka',
  'componentCanvas.panel.frames': {
    one: '{count} ramka',
    few: '{count} ramki',
    many: '{count} ramek',
    other: '{count} ramki',
  },
  'componentCanvas.panel.height': 'Wysokość',
  'componentCanvas.panel.hug': 'Do treści',
  'componentCanvas.panel.pixels': '{side} w pikselach',
  'componentCanvas.panel.props.hint':
    'Wartości, z którymi renderuje się ta ramka. Zostają na kanwie i wracają przy każdym jej otwarciu. Nigdy nie są zapisywane w komponencie ani w jego instancjach.',
  'componentCanvas.panel.props.none': 'Nie ustawiono',
  'componentCanvas.panel.props.split': 'Każda wartość właściwości {name} ma własną ramkę.',
  'componentCanvas.panel.props.title': 'Właściwości podglądu',
  'componentCanvas.panel.props.unused': 'Ten wariant nie używa właściwości {name}.',
  'componentCanvas.panel.scope.all': 'Wszystkie ramki',
  'componentCanvas.panel.scope.frame': 'Ta ramka',
  'componentCanvas.panel.scope.hint':
    'Zakres ustawianego rozmiaru, tła i wartości właściwości: ta ramka, wszystkie ramki jednej wartości lub wszystkie ramki. Własne ustawienie ramki ma pierwszeństwo przed szerszym.',
  'componentCanvas.panel.scope.label': 'Zastosuj do',
  'componentCanvas.panel.scope.part': 'Wszystkie ramki {part}',
  'componentCanvas.panel.scope.project': 'Wszystkie komponenty',
  'componentCanvas.panel.split.hint':
    'Każda wartość właściwości włączonej tutaj dostaje własną ramkę, a ramki pokazują wszystkie kombinacje. Wyłączona właściwość ma w każdej ramce jedną wartość, którą ustawiasz we właściwościach podglądu.',
  'componentCanvas.panel.split.title': 'Własne ramki',
  'componentCanvas.panel.split.toggle': 'Daj każdej wartości właściwości {name} własną ramkę',
  'componentCanvas.panel.transparent': 'Przezroczyste',
  'componentCanvas.panel.values': {
    one: '{count} wartość',
    few: '{count} wartości',
    many: '{count} wartości',
    other: '{count} wartości',
  },
  'componentCanvas.panel.width': 'Szerokość',
  'componentCanvas.popup.close': 'Zamknij ustawienia ramki',
  'componentCanvas.popup.title': 'Ustawienia ramki',
  'componentCanvas.titleBar.close': 'Zamknij kanwę {name}',
  'componentCanvas.zoom.fit': 'Dopasuj',
  'componentCanvas.zoom.fitAll': 'Dopasuj powiększenie do wszystkich ramek',
  'componentCanvas.zoom.in': 'Powiększ',
  'componentCanvas.zoom.out': 'Pomniejsz',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Powiększenie 100%',
} as const satisfies CatalogOf<MessageKey>;
