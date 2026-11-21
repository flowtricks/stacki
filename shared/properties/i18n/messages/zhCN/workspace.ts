// Simplified Chinese `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': '关闭（编辑会实时保存）',
  'workspace.code.title': '代码',
  'workspace.notifications.dismiss': '关闭通知',
  'workspace.notifications.label': '通知',
  'workspace.notifications.loadMore': '加载更多（{count}）',
  'workspace.notifications.showFewer': '收起',
  'workspace.terminal.close': '关闭终端',
  'workspace.terminal.custom': '自定义…',
  'workspace.terminal.customPlaceholder': '例如 bun run watch',
  'workspace.terminal.customTitle': '在每个新终端中运行一次',
  'workspace.terminal.hide': '隐藏终端（{shortcut}）',
  'workspace.terminal.loading': '正在加载终端',
  'workspace.terminal.new': '新建终端',
  'workspace.terminal.resize': '拖动以调整大小',
  'workspace.terminal.scrollBottom': '滚动到底部',
  'workspace.terminal.shellOnly': '仅 Shell',
} as const satisfies CatalogOf<MessageKey>;
