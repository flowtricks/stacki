// Traditional Chinese (Taiwan) `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AI 聊天',
  'rail.appWaiting': '{name}：{count} 個等待中',
  'rail.apps': 'App',
  'rail.assets': '素材',
  'rail.audits': '稽核',
  'rail.cms': 'CMS', // same
  'rail.code': '程式碼',
  'rail.collections': '集合',
  'rail.components': '元件',
  'rail.editorPanels': '編輯器面板',
  'rail.elements': '新增元素',
  'rail.history': 'Git', // same
  'rail.more': '更多',
  'rail.moveDown': '下移',
  'rail.moveIntoSettings': '移入「設定」',
  'rail.moveToBottom': '移至下方群組',
  'rail.moveToRail': '移至側邊欄',
  'rail.moveToTop': '移至上方群組',
  'rail.moveUp': '上移',
  'rail.movedBottom': '{label}：下方群組，第 {position} 個，共 {count} 個',
  'rail.movedSettings': '{label}：設定，第 {position} 個，共 {count} 個',
  'rail.movedTop': '{label}：上方群組，第 {position} 個，共 {count} 個',
  'rail.navigator': '導覽器',
  'rail.orderMenu': '側欄順序',
  'rail.pages': '頁面',
  'rail.properties': '屬性',
  'rail.reset': '重設側欄順序',
  'rail.resetDone': '已重設側欄順序',
  'rail.selectors': '樣式選取器',
  'rail.settings': '設定',
  'rail.settingsEmpty': '將側邊欄圖示拖曳到此處，即可保留在「設定」中',
  'rail.settingsOrder.description': '在側邊欄中拖曳圖示以重新排序，或重設為預設順序。',
  'rail.settingsOrder.done': '已重設側邊欄順序',
  'rail.settingsOrder.label': '側邊欄圖示順序',
  'rail.settingsOrder.reset': '重設為預設值',
  'rail.variables': '變數',
  'rail.withShortcut': '{label}（{shortcut}）',
} as const satisfies CatalogOf<MessageKey>;
