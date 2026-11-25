// Korean `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AI 채팅',
  'rail.appWaiting': '{name}: {count}개 대기 중',
  'rail.apps': '앱',
  'rail.assets': '에셋',
  'rail.audits': '검사',
  'rail.cms': 'CMS', // same
  'rail.code': '코드',
  'rail.collections': '컬렉션',
  'rail.components': '컴포넌트',
  'rail.editorPanels': '에디터 패널',
  'rail.elements': '요소 추가',
  'rail.files': '파일',
  'rail.history': 'Git', // same
  'rail.more': '더 보기',
  'rail.moveDown': '아래로 이동',
  'rail.moveToRail': '사이드바로 이동',
  'rail.moveUp': '위로 이동',
  'rail.movedBottom': '{label}: 아래 그룹, {count}개 중 {position}번째',
  'rail.movedSettings': '{label}: 설정, {count}개 중 {position}번째',
  'rail.movedTop': '{label}: 위 그룹, {count}개 중 {position}번째',
  'rail.navigator': '내비게이터',
  'rail.orderMenu': '레일 순서',
  'rail.pages': '페이지',
  'rail.properties': '속성',
  'rail.selectors': '스타일 선택자',
  'rail.settings': '설정',
  'rail.settingsEmpty': '사이드바 아이콘을 여기로 드래그하면 설정에 보관됩니다',
  'rail.settingsOrder.description': '사이드바의 아이콘을 드래그해 순서를 바꿉니다. 기본 순서로 초기화할 수 있습니다.',
  'rail.settingsOrder.done': '사이드바 순서를 초기화했습니다',
  'rail.settingsOrder.label': '사이드바 아이콘 순서',
  'rail.settingsOrder.reset': '기본값으로 초기화',
  'rail.variables': '변수',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
