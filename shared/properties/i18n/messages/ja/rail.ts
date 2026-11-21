// Japanese `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AIチャット',
  'rail.appWaiting': '{name}：{count}件待機中',
  'rail.apps': 'アプリ',
  'rail.assets': 'アセット',
  'rail.audits': '監査',
  'rail.cms': 'CMS', // same
  'rail.code': 'コード',
  'rail.collections': 'コレクション',
  'rail.components': 'コンポーネント',
  'rail.editorPanels': 'エディターパネル',
  'rail.history': 'Git', // same
  'rail.more': 'その他',
  'rail.moveToBottom': '下のグループへ移動',
  'rail.moveToTop': '上のグループへ移動',
  'rail.movedBottom': '{label}：下のグループ、{count}個中{position}番目',
  'rail.movedTop': '{label}：上のグループ、{count}個中{position}番目',
  'rail.navigator': 'ナビゲーター',
  'rail.orderMenu': 'レールの順序',
  'rail.pages': 'ページ',
  'rail.properties': 'プロパティ',
  'rail.reset': 'レールの順序をリセット',
  'rail.resetDone': 'レールの順序をリセットしました',
  'rail.selectors': 'スタイルセレクター',
  'rail.settings': '設定',
  'rail.settingsOrder.description': 'サイドバーのアイコンをドラッグして並べ替えます。デフォルトの順序に戻すこともできます。',
  'rail.settingsOrder.done': 'サイドバーの順序をリセットしました',
  'rail.settingsOrder.label': 'サイドバーアイコンの順序',
  'rail.settingsOrder.reset': 'デフォルトに戻す',
  'rail.variables': '変数',
  'rail.withShortcut': '{label}（{shortcut}）',
} as const satisfies CatalogOf<MessageKey>;
