// Japanese `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'キャンバスを開く前に、デフォルトのエディターを閉じてください。',
  'componentCanvas.error.notOpened': 'コンポーネントがキャンバスで開きませんでした。もう一度お試しください。',
  'componentCanvas.error.notReturned': '元のファイルに戻れませんでした。ページパネルから開いてください。',
  'componentCanvas.error.open': 'キャンバスを開けませんでした: {message}',
  'componentCanvas.error.save': 'キャンバスの設定を保存できませんでした: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': '未設定',
  'componentCanvas.menu.open': 'キャンバスで開く',
  'componentCanvas.notice.truncated':
    '{total} フレーム中、最初の {shown} フレームを表示しています。残りを表示するには、個別のフレームを持つプロパティを減らしてください。',
  'componentCanvas.pageName': '{name} キャンバス',
  'componentCanvas.panel.background': '背景',
  'componentCanvas.panel.backgroundVariable': '変数に接続',
  'componentCanvas.panel.fixed': '固定',
  'componentCanvas.panel.frame.hint':
    'フレームのラベルかコンポーネントの周囲の余白をクリックすると、フレームを選択できます。コンポーネントの内側をクリックすると編集できます。',
  'componentCanvas.panel.frame.pick': 'フレーム',
  'componentCanvas.panel.frame.title': 'フレーム',
  'componentCanvas.panel.frames': {
    other: '{count} フレーム',
  },
  'componentCanvas.panel.height': '高さ',
  'componentCanvas.panel.hug': 'コンテンツに合わせる',
  'componentCanvas.panel.pixels': '{side}（ピクセル）',
  'componentCanvas.panel.props.hint':
    'このフレームのレンダリングに使う値です。値はキャンバスに保持され、開くたびに復元されます。コンポーネントやそのインスタンスには書き込まれません。',
  'componentCanvas.panel.props.none': '未設定',
  'componentCanvas.panel.props.split': '{name} の値ごとに個別のフレームがあります。',
  'componentCanvas.panel.props.title': 'プレビュー用プロパティ',
  'componentCanvas.panel.props.unused': 'このバリアントは {name} を使用していません。',
  'componentCanvas.panel.scope.all': 'すべてのフレーム',
  'componentCanvas.panel.scope.frame': 'このフレーム',
  'componentCanvas.panel.scope.hint':
    '設定するサイズ、背景、プロパティ値の適用先です。このフレーム、ある値のすべてのフレーム、またはすべてのフレームから選びます。フレーム自体の設定は、より広い範囲の設定より優先されます。',
  'componentCanvas.panel.scope.label': '適用先',
  'componentCanvas.panel.scope.part': '{part} のすべてのフレーム',
  'componentCanvas.panel.scope.project': 'すべてのコンポーネント',
  'componentCanvas.panel.split.hint':
    'ここでオンにしたプロパティは値ごとに個別のフレームを持ち、フレームにはすべての組み合わせが表示されます。オフのプロパティはフレームごとに 1 つの値を表示し、その値は「プレビュー用プロパティ」で設定します。',
  'componentCanvas.panel.split.title': '個別のフレーム',
  'componentCanvas.panel.split.toggle': '{name} の値ごとに個別のフレームを作成',
  'componentCanvas.panel.transparent': '透明',
  'componentCanvas.panel.values': {
    other: '{count} 個の値',
  },
  'componentCanvas.panel.width': '幅',
  'componentCanvas.popup.close': 'フレーム設定を閉じる',
  'componentCanvas.popup.title': 'フレーム設定',
  'componentCanvas.titleBar.close': '{name} キャンバスを閉じる',
  'componentCanvas.zoom.fit': 'フィット',
  'componentCanvas.zoom.fitAll': 'すべてのフレームが収まるようにズーム',
  'componentCanvas.zoom.in': 'ズームイン',
  'componentCanvas.zoom.out': 'ズームアウト',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': '100% にズーム',
} as const satisfies CatalogOf<MessageKey>;
