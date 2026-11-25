// Traditional Chinese (Taiwan) `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': '關閉（編輯會即時儲存）',
  'workspace.code.title': '程式碼',
  'workspace.notifications.copied': '已複製',
  'workspace.notifications.copy': '複製',
  'workspace.notifications.dismiss': '關閉通知',
  'workspace.notifications.label': '通知',
  'workspace.notifications.loadMore': '載入更多（{count}）',
  'workspace.notifications.showFewer': '顯示較少',
  'workspace.terminal.close': '關閉終端機',
  'workspace.terminal.custom': '自訂…',
  'workspace.terminal.customPlaceholder': '例如 bun run watch',
  'workspace.terminal.customTitle': '在每個新終端機中執行一次',
  'workspace.terminal.hide': '隱藏終端機（{shortcut}）',
  'workspace.terminal.loading': '正在載入終端機',
  'workspace.terminal.new': '新增終端機',
  'workspace.terminal.resize': '拖曳以調整大小',
  'workspace.terminal.scrollBottom': '捲動到底部',
  'workspace.terminal.shellOnly': '僅 Shell',
} as const satisfies CatalogOf<MessageKey>;
