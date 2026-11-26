// Japanese `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'キャンバスを開く前に、デフォルトのエディターを閉じてください。',
  'componentCanvas.error.notOpened': 'コンポーネントがキャンバスで開きませんでした。もう一度お試しください。',
  'componentCanvas.error.notReturned': '元のファイルに戻れませんでした。ページパネルから開いてください。',
  'componentCanvas.error.open': 'キャンバスを開けませんでした: {message}',
  'componentCanvas.error.pageReadOnly':
    'このキャンバスはコンポーネントを表示するだけです。フレーム内のコンポーネントを編集するには、フレームをダブルクリックしてください。',
  'componentCanvas.error.previewValue': 'フレームで {name} としてプレビューできるのは値だけで、コードはプレビューできません。',
  'componentCanvas.error.save': 'キャンバスの設定を保存できませんでした: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': '未設定',
  'componentCanvas.level.all': 'すべてのフレームに設定',
  'componentCanvas.level.frame': 'このフレームには独自の値があります',
  'componentCanvas.level.overrides': {
    other: 'ここの {count} フレームは独自の値を保持しています。リセットするとこの値になります。',
  },
  'componentCanvas.level.part': 'すべての {part} フレームに設定',
  'componentCanvas.menu.open': 'キャンバスで開く',
  'componentCanvas.notice.truncated':
    '{total} フレーム中、最初の {shown} フレームを表示しています。残りを表示するには、個別のフレームを持つプロパティを減らしてください。',
  'componentCanvas.pageName': '{name} キャンバス',
  'componentCanvas.panel.background': '背景',
  'componentCanvas.panel.backgroundVariable': '変数に接続',
  'componentCanvas.panel.fixed': '固定',
  'componentCanvas.panel.frames': {
    other: '{count} フレーム',
  },
  'componentCanvas.panel.height': '高さ',
  'componentCanvas.panel.hug': 'コンテンツに合わせる',
  'componentCanvas.panel.pixels': '{side}（ピクセル）',
  'componentCanvas.panel.root.about': 'すべてのフレームの背後にあるキャンバスで、ページの html 要素です。そのクラスは設定パネルにあります。',
  'componentCanvas.panel.root.title': 'キャンバス',
  'componentCanvas.panel.scope.all': 'すべてのフレーム',
  'componentCanvas.panel.scope.component': 'このコンポーネント',
  'componentCanvas.panel.scope.frame': 'このフレーム',
  'componentCanvas.panel.scope.hint':
    '設定するサイズ、背景、プロパティ値の適用先です。このフレーム、ある値のすべてのフレーム、またはすべてのフレームから選びます。フレーム自体の設定は、より広い範囲の設定より優先されます。',
  'componentCanvas.panel.scope.label': '適用先',
  'componentCanvas.panel.scope.part': '{part} のすべてのフレーム',
  'componentCanvas.panel.scope.project': 'すべてのコンポーネント',
  'componentCanvas.panel.size': 'サイズ',
  'componentCanvas.panel.transparent': '透明',
  'componentCanvas.panel.width': '幅',
  'componentCanvas.popup.expand': 'フレーム設定を展開',
  'componentCanvas.popup.minimize': 'フレーム設定を最小化',
  'componentCanvas.popup.title': 'フレーム設定',
  'componentCanvas.scope.valueFrames': '{value} のすべてのフレーム',
  'componentCanvas.split.full': '個別のフレームを持てるプロパティは {max} 個までです。先にいずれかをオフにしてください。',
  'componentCanvas.split.locked': '{name} の値ごとに個別のフレームがあります。',
  'componentCanvas.split.off': {
    other: '{name} の値ごとに個別のフレームを表示（値 {count} 個）',
  },
  'componentCanvas.split.on': '{name} を 1 つのフレームに表示',
  'componentCanvas.titleBar.close': '{name} キャンバスを閉じる',
  'componentCanvas.zoom.fit': 'フィット',
  'componentCanvas.zoom.fitAll': 'すべてのフレームが収まるようにズーム',
  'componentCanvas.zoom.in': 'ズームイン',
  'componentCanvas.zoom.out': 'ズームアウト',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': '100% にズーム',
} as const satisfies CatalogOf<MessageKey>;
