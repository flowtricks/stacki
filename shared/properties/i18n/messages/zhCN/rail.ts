// Simplified Chinese `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AI 聊天',
  'rail.appWaiting': '{name}：{count} 个待处理',
  'rail.apps': '应用',
  'rail.assets': '资源',
  'rail.audits': '审查',
  'rail.cms': 'CMS', // same
  'rail.code': '代码',
  'rail.collections': '集合',
  'rail.components': '组件',
  'rail.editorPanels': '编辑器面板',
  'rail.elements': '添加元素',
  'rail.files': '文件',
  'rail.history': 'Git', // same
  'rail.more': '更多',
  'rail.moveDown': '下移',
  'rail.moveToRail': '移到侧栏',
  'rail.moveUp': '上移',
  'rail.movedBottom': '{label}：底部分组，第 {position} 位，共 {count} 位',
  'rail.movedSettings': '{label}：设置，第 {position} 位，共 {count} 位',
  'rail.movedTop': '{label}：顶部分组，第 {position} 位，共 {count} 位',
  'rail.navigator': '导航器',
  'rail.orderMenu': '侧栏顺序',
  'rail.pages': '页面',
  'rail.properties': '属性',
  'rail.selectors': '样式选择器',
  'rail.settings': '设置',
  'rail.settingsEmpty': '将侧栏图标拖到此处，即可保留在“设置”中',
  'rail.settingsOrder.description': '拖动侧栏中的图标可重新排序。也可重置为默认顺序。',
  'rail.settingsOrder.done': '已重置侧栏顺序',
  'rail.settingsOrder.label': '侧栏图标顺序',
  'rail.settingsOrder.reset': '重置为默认',
  'rail.variables': '变量',
  'rail.withShortcut': '{label}（{shortcut}）',
} as const satisfies CatalogOf<MessageKey>;
