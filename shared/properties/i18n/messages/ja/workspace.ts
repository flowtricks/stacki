// Japanese `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': '閉じる（編集内容は自動で保存されます）',
  'workspace.code.title': 'コード',
  'workspace.notifications.copied': 'コピーしました',
  'workspace.notifications.copy': 'コピー',
  'workspace.notifications.dismiss': '通知を閉じる',
  'workspace.notifications.label': '通知',
  'workspace.notifications.loadMore': 'さらに読み込む（{count}）',
  'workspace.notifications.showFewer': '表示を減らす',
  'workspace.terminal.close': 'ターミナルを閉じる',
  'workspace.terminal.custom': 'カスタム…',
  'workspace.terminal.customPlaceholder': '例：bun run watch',
  'workspace.terminal.customTitle': '新しいターミナルごとに1回実行',
  'workspace.terminal.hide': 'ターミナルを隠す（{shortcut}）',
  'workspace.terminal.loading': 'ターミナルを読み込み中',
  'workspace.terminal.new': '新規ターミナル',
  'workspace.terminal.resize': 'ドラッグしてサイズを変更',
  'workspace.terminal.scrollBottom': '一番下までスクロール',
  'workspace.terminal.shellOnly': 'シェルのみ',
} as const satisfies CatalogOf<MessageKey>;
