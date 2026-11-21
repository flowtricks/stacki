// Russian `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Закрыть (правки сохраняются сразу)',
  'workspace.code.title': 'Код',
  'workspace.notifications.dismiss': 'Скрыть уведомление',
  'workspace.notifications.label': 'Уведомления',
  'workspace.notifications.loadMore': 'Показать ещё ({count})',
  'workspace.notifications.showFewer': 'Показать меньше',
  'workspace.terminal.close': 'Закрыть терминал',
  'workspace.terminal.custom': 'Своя команда…',
  'workspace.terminal.customPlaceholder': 'например, bun run watch',
  'workspace.terminal.customTitle': 'Выполняется один раз в каждом новом терминале',
  'workspace.terminal.hide': 'Скрыть терминал ({shortcut})',
  'workspace.terminal.loading': 'Загрузка терминала',
  'workspace.terminal.new': 'Новый терминал',
  'workspace.terminal.resize': 'Перетащите, чтобы изменить размер',
  'workspace.terminal.scrollBottom': 'Прокрутить вниз',
  'workspace.terminal.shellOnly': 'Только оболочка',
} as const satisfies CatalogOf<MessageKey>;
