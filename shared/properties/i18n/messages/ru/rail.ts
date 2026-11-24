// Russian `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Чат с ИИ',
  'rail.appWaiting': '{name}: ожидает {count}',
  'rail.apps': 'Приложения',
  'rail.assets': 'Ресурсы',
  'rail.audits': 'Аудиты',
  'rail.cms': 'CMS', // same
  'rail.code': 'Код',
  'rail.collections': 'Коллекции',
  'rail.components': 'Компоненты',
  'rail.editorPanels': 'Панели редактора',
  'rail.elements': 'Добавить элементы',
  'rail.history': 'Git', // same
  'rail.more': 'Ещё',
  'rail.moveDown': 'Переместить вниз',
  'rail.moveToRail': 'Переместить на боковую панель',
  'rail.moveUp': 'Переместить вверх',
  'rail.movedBottom': '{label}: нижняя группа, позиция {position} из {count}',
  'rail.movedSettings': '{label}: настройки, позиция {position} из {count}',
  'rail.movedTop': '{label}: верхняя группа, позиция {position} из {count}',
  'rail.navigator': 'Навигатор',
  'rail.orderMenu': 'Порядок на панели',
  'rail.pages': 'Страницы',
  'rail.properties': 'Свойства',
  'rail.selectors': 'Селекторы стилей',
  'rail.settings': 'Настройки',
  'rail.settingsEmpty': 'Перетащите сюда значки боковой панели, чтобы оставить их в настройках',
  'rail.settingsOrder.description': 'Перетаскивайте значки на боковой панели, чтобы изменить их порядок. Можно вернуть порядок по умолчанию.',
  'rail.settingsOrder.done': 'Порядок на боковой панели сброшен',
  'rail.settingsOrder.label': 'Порядок значков боковой панели',
  'rail.settingsOrder.reset': 'Сбросить по умолчанию',
  'rail.variables': 'Переменные',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
