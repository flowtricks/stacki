// Polish `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Czat AI',
  'rail.appWaiting': '{name}: oczekuje {count}',
  'rail.apps': 'Aplikacje',
  'rail.assets': 'Zasoby',
  'rail.audits': 'Audyty',
  'rail.cms': 'CMS', // same
  'rail.code': 'Kod',
  'rail.collections': 'Kolekcje',
  'rail.components': 'Komponenty',
  'rail.editorPanels': 'Panele edytora',
  'rail.elements': 'Dodaj elementy',
  'rail.files': 'Pliki',
  'rail.history': 'Git', // same
  'rail.more': 'Więcej',
  'rail.moveDown': 'Przenieś w dół',
  'rail.moveToRail': 'Przenieś na pasek boczny',
  'rail.moveUp': 'Przenieś w górę',
  'rail.movedBottom': '{label}: dolna grupa, pozycja {position} z {count}',
  'rail.movedSettings': '{label}: Ustawienia, pozycja {position} z {count}',
  'rail.movedTop': '{label}: górna grupa, pozycja {position} z {count}',
  'rail.navigator': 'Nawigator',
  'rail.orderMenu': 'Kolejność paska',
  'rail.pages': 'Strony',
  'rail.properties': 'Właściwości',
  'rail.selectors': 'Selektory stylów',
  'rail.settings': 'Ustawienia',
  'rail.settingsEmpty': 'Przeciągnij tutaj ikony paska bocznego, aby zachować je w Ustawieniach',
  'rail.settingsOrder.description': 'Przeciągaj ikony na pasku bocznym, aby zmienić ich kolejność. Zresetuj do kolejności domyślnej.',
  'rail.settingsOrder.done': 'Zresetowano kolejność paska bocznego',
  'rail.settingsOrder.label': 'Kolejność ikon paska bocznego',
  'rail.settingsOrder.reset': 'Przywróć domyślną',
  'rail.variables': 'Zmienne',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
