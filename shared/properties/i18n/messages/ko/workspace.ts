// Korean `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': '닫기(편집 내용은 자동으로 저장됨)',
  'workspace.code.title': '코드',
  'workspace.notifications.dismiss': '알림 닫기',
  'workspace.notifications.label': '알림',
  'workspace.notifications.loadMore': '더 불러오기({count})',
  'workspace.notifications.showFewer': '간략히 보기',
  'workspace.terminal.close': '터미널 닫기',
  'workspace.terminal.custom': '사용자 지정…',
  'workspace.terminal.customPlaceholder': '예: bun run watch',
  'workspace.terminal.customTitle': '새 터미널마다 한 번 실행',
  'workspace.terminal.hide': '터미널 숨기기({shortcut})',
  'workspace.terminal.loading': '터미널 불러오는 중',
  'workspace.terminal.new': '새 터미널',
  'workspace.terminal.resize': '드래그하여 크기 조절',
  'workspace.terminal.scrollBottom': '맨 아래로 스크롤',
  'workspace.terminal.shellOnly': '셸만',
} as const satisfies CatalogOf<MessageKey>;
