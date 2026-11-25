// Traditional Chinese (Taiwan) `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': '開啟畫布前，請先關閉預設值編輯器。',
  'componentCanvas.error.notOpened': '元件未能在畫布上開啟。請再試一次。',
  'componentCanvas.error.notReturned': '無法返回你先前所在的檔案。請從「頁面」面板開啟。',
  'componentCanvas.error.open': '無法開啟畫布：{message}',
  'componentCanvas.error.save': '無法儲存畫布設定：{message}',
  'componentCanvas.frame.part': '{prop}：{value}',
  'componentCanvas.frame.unset': '未設定',
  'componentCanvas.menu.open': '開啟畫布',
  'componentCanvas.notice.truncated': '正在顯示 {total} 個框架中的前 {shown} 個。若要查看其餘框架，請減少擁有獨立框架的屬性。',
  'componentCanvas.pageName': '{name} 畫布',
  'componentCanvas.panel.background': '背景',
  'componentCanvas.panel.fixed': '固定',
  'componentCanvas.panel.frame.hint': '按一下框架的標籤或元件周圍的空白處即可選取該框架。按一下元件內部即可編輯元件。',
  'componentCanvas.panel.frame.pick': '框架',
  'componentCanvas.panel.frame.title': '框架',
  'componentCanvas.panel.frames': {
    other: '{count} 個框架',
  },
  'componentCanvas.panel.height': '高度',
  'componentCanvas.panel.hug': '貼合內容',
  'componentCanvas.panel.pixels': '{side}（像素）',
  'componentCanvas.panel.props.hint': '此框架算繪時使用的值。這些值會保留在畫布上，每次開啟畫布時都會還原。它們絕不會寫入元件或其實例。',
  'componentCanvas.panel.props.none': '未設定',
  'componentCanvas.panel.props.split': '{name} 的每個值都有自己的框架。',
  'componentCanvas.panel.props.title': '預覽屬性',
  'componentCanvas.panel.props.unused': '此變體未使用 {name}。',
  'componentCanvas.panel.scope.all': '所有框架',
  'componentCanvas.panel.scope.frame': '此框架',
  'componentCanvas.panel.scope.hint': '你設定的尺寸、背景與屬性值的套用範圍：此框架、某個值的所有框架，或所有框架。框架本身的設定優先於範圍較廣的設定。',
  'componentCanvas.panel.scope.label': '套用至',
  'componentCanvas.panel.scope.part': '所有 {part} 框架',
  'componentCanvas.panel.split.hint':
    '在此開啟的屬性，每個值都有自己的框架，這些框架會顯示所有組合。未開啟的屬性在每個框架中只顯示一個值，該值在「預覽屬性」中設定。',
  'componentCanvas.panel.split.title': '獨立框架',
  'componentCanvas.panel.split.toggle': '讓 {name} 的每個值各有獨立框架',
  'componentCanvas.panel.transparent': '透明',
  'componentCanvas.panel.values': {
    other: '{count} 個值',
  },
  'componentCanvas.panel.width': '寬度',
  'componentCanvas.titleBar.close': '關閉 {name} 畫布',
  'componentCanvas.zoom.fit': '符合',
  'componentCanvas.zoom.fitAll': '縮放以顯示所有框架',
  'componentCanvas.zoom.in': '放大',
  'componentCanvas.zoom.out': '縮小',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': '縮放至 100%',
} as const satisfies CatalogOf<MessageKey>;
