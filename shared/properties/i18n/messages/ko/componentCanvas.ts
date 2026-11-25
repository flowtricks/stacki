// Korean `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': '캔버스를 열기 전에 기본값 편집기를 닫으세요.',
  'componentCanvas.error.notOpened': '컴포넌트가 캔버스에서 열리지 않았습니다. 다시 시도하세요.',
  'componentCanvas.error.notReturned': '작업하던 파일로 돌아갈 수 없습니다. 페이지 패널에서 여세요.',
  'componentCanvas.error.open': '캔버스를 열 수 없습니다: {message}',
  'componentCanvas.error.save': '캔버스 설정을 저장할 수 없습니다: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': '설정 안 됨',
  'componentCanvas.menu.open': '캔버스 열기',
  'componentCanvas.notice.truncated': '전체 {total}개 중 처음 {shown}개의 프레임을 표시합니다. 나머지를 보려면 개별 프레임을 갖는 속성을 줄이세요.',
  'componentCanvas.pageName': '{name} 캔버스',
  'componentCanvas.panel.background': '배경',
  'componentCanvas.panel.fixed': '고정',
  'componentCanvas.panel.frame.hint': '프레임의 레이블이나 컴포넌트 주변의 빈 공간을 클릭하면 프레임이 선택됩니다. 컴포넌트 안을 클릭하면 편집할 수 있습니다.',
  'componentCanvas.panel.frame.pick': '프레임',
  'componentCanvas.panel.frame.title': '프레임',
  'componentCanvas.panel.frames': {
    other: '프레임 {count}개',
  },
  'componentCanvas.panel.height': '높이',
  'componentCanvas.panel.hug': '콘텐츠에 맞춤',
  'componentCanvas.panel.pixels': '{side}(픽셀)',
  'componentCanvas.panel.props.hint':
    '이 프레임을 렌더링할 때 사용하는 값입니다. 값은 캔버스에 남아 캔버스를 열 때마다 다시 적용됩니다. 컴포넌트나 그 인스턴스에는 절대 기록되지 않습니다.',
  'componentCanvas.panel.props.none': '설정 안 됨',
  'componentCanvas.panel.props.split': '{name}의 각 값마다 개별 프레임이 있습니다.',
  'componentCanvas.panel.props.title': '미리보기 속성',
  'componentCanvas.panel.props.unused': '이 베리언트는 {name}을(를) 사용하지 않습니다.',
  'componentCanvas.panel.scope.all': '모든 프레임',
  'componentCanvas.panel.scope.frame': '이 프레임',
  'componentCanvas.panel.scope.hint':
    '설정한 크기, 배경, 속성 값이 적용되는 범위입니다. 이 프레임, 한 값의 모든 프레임, 또는 모든 프레임 중에서 선택합니다. 프레임 자체의 설정이 더 넓은 범위의 설정보다 우선합니다.',
  'componentCanvas.panel.scope.label': '적용 대상',
  'componentCanvas.panel.scope.part': '모든 {part} 프레임',
  'componentCanvas.panel.split.hint':
    '여기에서 켠 속성은 값마다 개별 프레임을 가지며, 프레임에는 모든 조합이 표시됩니다. 꺼 둔 속성은 프레임마다 하나의 값을 표시하며, 그 값은 미리보기 속성에서 설정합니다.',
  'componentCanvas.panel.split.title': '개별 프레임',
  'componentCanvas.panel.split.toggle': '{name}의 각 값에 개별 프레임 만들기',
  'componentCanvas.panel.transparent': '투명',
  'componentCanvas.panel.values': {
    other: '값 {count}개',
  },
  'componentCanvas.panel.width': '너비',
  'componentCanvas.titleBar.close': '{name} 캔버스 닫기',
  'componentCanvas.zoom.fit': '맞춤',
  'componentCanvas.zoom.fitAll': '모든 프레임이 보이도록 확대/축소',
  'componentCanvas.zoom.in': '확대',
  'componentCanvas.zoom.out': '축소',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': '100%로 확대/축소',
} as const satisfies CatalogOf<MessageKey>;
